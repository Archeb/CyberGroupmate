/**
 * visibility-policy.ts — 全局 Visibility 隐私兜底（单一事实来源）
 *
 * 把 `visibility` 从"fact 级别字段"提升为"按 chat 分级的全局隐私概念"，并在代码层
 * （而非依赖 LLM 自觉）对每一次跨群隐私读写做兜底检查。被两个 chokepoint 复用：
 * - Subagent CodeAct：`src/sandbox/host-call-handler.ts`
 * - Meta Agent：`src/meta-sandbox/meta-api/*`
 *
 * 分级：
 *   getChatVisibility(chatId) = "private"  当 (DM 且 dmAutoPrivate) 或 (配置种子 sensitiveChats)
 *                                              或 (GroupModel.markedSensitive)
 *                            = "shared"   其它（普通群）
 *
 * 两条不变式（boundChatId = C 为当前执行上下文绑定的 chat）：
 *   R1 读隔离：跨群读取一个 private 且 ≠ C 的 chat 的数据 → 不得进入当前上下文
 *              （显式 target → 拒绝；聚合 → scrub 掉私密且≠C 的行）。
 *   R2 写隔离：当 C 为 private 时，向 ≠ C 的目标 send/dispatch → 硬报错；
 *              dispatch 额外禁止把任务派进别人的 private chat。
 *
 * shared ↔ shared 跨群读写仍放行（保留跨群编排能力）；想全锁死用
 * `subagent.restrictAdapterWritesToBoundChat`（更严的超集开关）。
 */

import { getRawId, safeGroupModelKey } from "./chat-id.js";

export type ChatVisibility = "private" | "shared";

/** 命中越界时的处理模式。 */
export type EnforceMode = "block" | "warn" | "off";

/** GroupModel 中与隐私分级相关的最小读取面。 */
export interface GroupModelVisibilityFields {
    isDirectMessage?: boolean;
    markedSensitive?: boolean;
}

/** 计算 visibility 所需依赖（与具体 MemoryStore 实现解耦，便于测试）。 */
export interface VisibilityDeps {
    /** 读取 GroupModel（调用方传入 memory.getGroupModel）。 */
    getGroupModel(key: string): GroupModelVisibilityFields | null | undefined;
    /** 人工配置种子：始终视为 private 的 composite chatId。 */
    sensitiveSeed: ReadonlySet<string>;
    /** DM 是否自动判为 private（默认 true）。 */
    dmAutoPrivate: boolean;
}

/** 越界信息（用于 warn 模式告警 / 审计）。 */
export interface VisibilityViolation {
    kind: "egress-write" | "egress-dispatch" | "read-explicit" | "read-scrub";
    method?: string;
    boundChatId: string;
    targetChatId?: string;
    droppedCount?: number;
}

/** 一次兜底检查的运行时上下文。 */
export interface PolicyContext {
    /** 当前执行绑定的 chat（C）。Meta（无绑定）传空串 ""，使任何 private 行都被视作跨界。 */
    boundChatId: string;
    enforce: EnforceMode;
    deps: VisibilityDeps;
    /** 命中（无论 block/warn）时回调，用于日志 / Dashboard 告警。 */
    onViolation?: (v: VisibilityViolation) => void;
}

/**
 * 计算某个 chat 的 visibility。
 * 同时检查 chatId 原值与 groupModelKey（Discord channel→guild 归并）两种形态命中配置种子。
 */
/** 从隐私配置 + GroupModel 读取器构建 VisibilityDeps（两个 chokepoint 共用，保持纯函数）。 */
export function buildVisibilityDeps(opts: {
    getGroupModel: (key: string) => GroupModelVisibilityFields | null | undefined;
    sensitiveChats?: string[];
    dmAutoPrivate?: boolean;
}): VisibilityDeps {
    return {
        getGroupModel: opts.getGroupModel,
        sensitiveSeed: new Set(opts.sensitiveChats ?? []),
        dmAutoPrivate: opts.dmAutoPrivate !== false,
    };
}

/**
 * 从隐私配置 + GroupModel 读取器组装 PolicyContext（两个 chokepoint 共用，保持纯函数）。
 * boundChatId 为空串表示 Meta（无当前会话）：任何 private 会话都视作跨界。
 */
export function makePolicyContext(opts: {
    boundChatId: string;
    privacy: { sensitiveChats?: string[]; dmAutoPrivate?: boolean; enforce: EnforceMode };
    getGroupModel: (key: string) => GroupModelVisibilityFields | null | undefined;
    onViolation?: (v: VisibilityViolation) => void;
}): PolicyContext {
    return {
        boundChatId: opts.boundChatId,
        enforce: opts.privacy.enforce,
        deps: buildVisibilityDeps({
            getGroupModel: opts.getGroupModel,
            sensitiveChats: opts.privacy.sensitiveChats,
            dmAutoPrivate: opts.privacy.dmAutoPrivate,
        }),
        onViolation: opts.onViolation,
    };
}

export function getChatVisibility(chatId: string | null | undefined, deps: VisibilityDeps): ChatVisibility {
    if (!chatId) return "shared";

    const groupKey = safeGroupModelKey(chatId);

    // 种子既可填 composite（telegram:-100…）也可填裸 rawId（-100…，文档/习惯写法），两种形态都要命中。
    if (deps.sensitiveSeed.has(chatId) || deps.sensitiveSeed.has(groupKey)
        || deps.sensitiveSeed.has(getRawId(chatId)) || deps.sensitiveSeed.has(getRawId(groupKey))) {
        return "private";
    }

    const gm = deps.getGroupModel(groupKey) ?? (groupKey !== chatId ? deps.getGroupModel(chatId) : null);
    if (gm?.markedSensitive) return "private";
    if (deps.dmAutoPrivate && gm?.isDirectMessage) return "private";

    return "shared";
}

export function isPrivateChat(chatId: string | null | undefined, deps: VisibilityDeps): boolean {
    return getChatVisibility(chatId, deps) === "private";
}

/** 越界异常（block 模式抛出）。 */
export class VisibilityViolationError extends Error {
    readonly violation: VisibilityViolation;
    constructor(message: string, violation: VisibilityViolation) {
        super(message);
        this.name = "VisibilityViolationError";
        this.violation = violation;
    }
}

function report(ctx: PolicyContext, v: VisibilityViolation): void {
    try {
        ctx.onViolation?.(v);
    } catch {
        /* 告警回调失败不影响主流程 */
    }
}

/**
 * R2 — 写/exfil 兜底。
 * 对 adapter 写方法 / dispatch 调用，按 kind 判定是否越界：
 * - kind="egress-write"：当 C 为 private 且 target ≠ C → 越界（私密群内容不得直接发出）。
 * - kind="egress-dispatch"：当 (C 为 private 或 target 为 private) 且 target ≠ C → 越界
 *   （私密群不得派任务出去，也不得把任务派进别人的私密群）。
 * block 模式抛 VisibilityViolationError；warn 模式仅告警；off 模式放行。
 */
export function assertEgressAllowed(
    kind: "egress-write" | "egress-dispatch",
    method: string,
    targetChatId: string | null | undefined,
    ctx: PolicyContext,
): void {
    if (ctx.enforce === "off") return;
    const target = (targetChatId ?? "").trim();
    if (!target || target === ctx.boundChatId) return;

    const boundPrivate = isPrivateChat(ctx.boundChatId, ctx.deps);
    const targetPrivate = isPrivateChat(target, ctx.deps);

    const violates = kind === "egress-write" ? boundPrivate : (boundPrivate || targetPrivate);
    if (!violates) return;

    const v: VisibilityViolation = { kind, method, boundChatId: ctx.boundChatId, targetChatId: target };
    report(ctx, v);
    if (ctx.enforce !== "block") return;

    const action = kind === "egress-dispatch" ? "向其它 chat 派发任务" : "向其它 chat 发送消息";
    const which = boundPrivate ? `当前会话(${ctx.boundChatId})被判定为私密` : `目标会话(${target})被判定为私密`;
    throw new VisibilityViolationError(
        `[隐私兜底] ${method} 被拦截：${which}，禁止${action}（私密内容不得跨会话外泄）。`
        + `如这是误判，可由管理员调整 privacy.sensitiveChats / dmAutoPrivate 配置。`,
        v,
    );
}

/**
 * R1（显式 target）— 当代码显式请求读取一个 private 且 ≠ C 的 chat 时，是否应拒绝。
 * 返回 true 表示该次读取应被遮蔽（调用方返回空结果 + 注记）。
 */
export function isExplicitReadBlocked(
    targetChatId: string | null | undefined,
    ctx: PolicyContext,
): boolean {
    if (ctx.enforce === "off") return false;
    const target = (targetChatId ?? "").trim();
    if (!target || target === ctx.boundChatId) return false;
    if (!isPrivateChat(target, ctx.deps)) return false;
    report(ctx, { kind: "read-explicit", boundChatId: ctx.boundChatId, targetChatId: target });
    return ctx.enforce === "block"; // warn 仅告警不拦截
}

export interface ScrubResult<T> {
    kept: T[];
    dropped: number;
}

/**
 * R1（聚合）通用过滤器：按 isCrossPrivate 判定逐项丢弃。
 * - off / 无命中：原样返回输入引用（不复制，热路径常见情形）。
 * - block：丢弃命中项（命中后才开始复制数组）。
 * - warn：保留全部但记录命中数。
 * 调用方把 `.kept` 当只读使用（spread / 迭代 / 赋值回去），不会就地修改。
 */
function scrubByVisibility<T>(
    items: readonly T[],
    isCrossPrivate: (item: T) => boolean,
    ctx: PolicyContext,
    method?: string,
): ScrubResult<T> {
    if (ctx.enforce === "off" || !Array.isArray(items)) {
        return { kept: (items ?? []) as T[], dropped: 0 };
    }
    let kept: T[] | null = null; // null = 尚无丢弃，可复用原数组
    let flagged = 0;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (isCrossPrivate(item)) {
            flagged++;
            if (ctx.enforce === "block") {
                if (kept === null) kept = items.slice(0, i); // 首次丢弃：拷贝前缀
                continue;
            }
        }
        if (kept !== null) kept.push(item);
    }
    if (flagged > 0) {
        report(ctx, { kind: "read-scrub", method, boundChatId: ctx.boundChatId, droppedCount: flagged });
    }
    return { kept: kept ?? (items as T[]), dropped: ctx.enforce === "block" ? flagged : 0 };
}

/**
 * R1（聚合）— 丢弃"来源为 private 且 ≠ C"的行。
 * @param getRowChatId 从行中取来源 chatId（消息/话题/交互/画像均用其 chatId）。
 */
export function scrubRowsByVisibility<T>(
    rows: readonly T[],
    getRowChatId: (row: T) => string | null | undefined,
    ctx: PolicyContext,
    method?: string,
): ScrubResult<T> {
    return scrubByVisibility(rows, (row) => {
        const rc = (getRowChatId(row) ?? "").trim();
        return !!rc && rc !== ctx.boundChatId && isPrivateChat(rc, ctx.deps);
    }, ctx, method);
}

/** fact 行的最小形态（用 visibility + sourceChatId 判定）。 */
export interface FactVisibilityFields {
    visibility?: "private" | "contextual" | "public";
    sourceChatId?: string | null;
}

/**
 * R1（聚合，fact 专用）— 丢弃来源 ≠ C 且任一为真的 fact：
 * - fact 自身被标记 `visibility=private`，或
 * - 其来源会话本身是私密会话（DM / 配置种子 / 运行时 markedSensitive，经 getChatVisibility 判定）。
 * 后一条很关键：reflection 默认把群内 fact 存成 `contextual`，因此只看 fact 级 visibility 会漏掉
 * 「来自敏感群但未单独标私密的 fact」——必须同时看来源会话的 chat 级 visibility。
 */
export function scrubFactsByVisibility<T extends FactVisibilityFields>(
    facts: readonly T[],
    ctx: PolicyContext,
    method?: string,
): ScrubResult<T> {
    return scrubByVisibility(
        facts,
        (fact) => {
            const src = fact.sourceChatId ?? null;
            if (src === ctx.boundChatId) return false; // 本会话的 fact 始终保留
            return fact.visibility === "private" || isPrivateChat(src, ctx.deps);
        },
        ctx,
        method,
    );
}
