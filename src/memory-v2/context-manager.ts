import { createLogger } from "../core/logger.js";
import { callLLMWithFallback, type ChatMessage } from "../core/llm.js";
import { loadConfig, resolveComponentTimeout, type LLMConfig } from "../core/config.js";
import { loadPromptFile, registerCacheClear } from "../core/prompt-loader.js";
import { join } from "node:path";
import { encodingForModel } from "js-tiktoken";

const log = createLogger("context-mgr");

// ─── 类型 ───

/** Token 预算配置 */
export interface ContextBudget {
    /** 模型的有效上下文窗口（token 数）。默认 32000 */
    effectiveContextWindow: number;
    /** 分配给 system prompt 的预算比例。默认 0.20 */
    systemPromptRatio: number;
    /** 分配给 context briefing 的预算比例。默认 0.15 */
    briefingRatio: number;
    /** 分配给 recent history 的预算比例。默认 0.50 */
    recentHistoryRatio: number;
    /** 预留给当前轮次 output 的预算（固定值）。默认 4096 */
    outputReserve: number;
    /** 最少保留的近期消息条数。默认 6 */
    minRecentMessages: number;
    /** Context Briefing 最大 token 数。默认 3000 */
    maxBriefingTokens: number;
}

/** 默认预算 */
export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
    effectiveContextWindow: 32000,
    systemPromptRatio: 0.20,
    briefingRatio: 0.15,
    recentHistoryRatio: 0.50,
    outputReserve: 4096,
    minRecentMessages: 6,
    maxBriefingTokens: 3000,
};

/**
 * 从 config.yaml 加载 context_budget 配置，与 DEFAULT_CONTEXT_BUDGET 合并。
 * 未配置时直接返回默认值。
 */
function getConfiguredBudget(): ContextBudget {
    try {
        const cfg = loadConfig();
        if (!cfg.contextBudget) return DEFAULT_CONTEXT_BUDGET;
        return { ...DEFAULT_CONTEXT_BUDGET, ...cfg.contextBudget };
    } catch {
        return DEFAULT_CONTEXT_BUDGET;
    }
}

/** 消息分类结果 */
export interface ClassifiedMessages {
    /** System prompt (messages[0]) */
    systemPrompt: ChatMessage | null;
    /** 现有的 Context Briefing（如果有） */
    briefing: ChatMessage | null;
    /** 压缩候选消息（中间部分） */
    candidates: ChatMessage[];
    /** 受保护的近期消息（尾部） */
    recent: ChatMessage[];
}

/** 话题保护标记 */
export interface ProtectionResult {
    /** 受保护的消息索引集合 */
    protectedIndices: Set<number>;
    /** 保护原因映射 */
    reasons: Map<number, string>;
}

// ─── CJK 检测正则 ───

/**
 * CJK 统一表意文字 + 常用标点范围
 */
const CJK_REGEX = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\u{20000}-\u{2FA1F}]/gu;

// ─── Token 计算 ───

/** 惰性初始化的 tiktoken encoder (cl100k_base, GPT-4 / embedding 模型) */
let _encoder: ReturnType<typeof encodingForModel> | null = null;
let _encoderFailed = false;

function getEncoder() {
    if (_encoder) return _encoder;
    if (_encoderFailed) return null;
    try {
        _encoder = encodingForModel("gpt-4o");
        log.debug("tiktoken encoder 初始化成功", { encoding: "cl100k_base" });
        return _encoder;
    } catch (err) {
        _encoderFailed = true;
        log.warn("tiktoken encoder 初始化失败，fallback CJK 启发式", { error: String(err) });
        return null;
    }
}

/**
 * Token 计数记忆化缓存。
 *
 * js-tiktoken 的 BPE 在长 CJK 串（中文没有空格，切分出的 chunk 很长）上非常慢，
 * 而 shouldCompact / classifyMessages / forceTrim 会对同一批消息反复计数。
 * 这里对较长文本做有界 LRU 缓存，避免重复编码。
 */
const TOKEN_CACHE_MAX_ENTRIES = 1024;
const TOKEN_CACHE_MIN_LENGTH = 64;
const _tokenCache = new Map<string, number>();

/**
 * 超过此长度直接走启发式估算。
 *
 * js-tiktoken 的 BPE 在长且无分隔符的串（base64、压缩 JSON、无空格中文）上是超线性的，
 * 几万字符可以卡住事件循环好几秒到几十秒。预算判断有 0.85 的安全系数，
 * 这里牺牲一点精度换取可预测的耗时。
 */
const TOKEN_EXACT_MAX_LENGTH = 16_000;

function encodeTokenCount(text: string): number {
    if (text.length > TOKEN_EXACT_MAX_LENGTH) {
        return estimateTokensFallback(text);
    }

    const enc = getEncoder();
    if (enc) {
        try {
            return enc.encode(text).length;
        } catch {
            // 罕见：编码失败，fallback
        }
    }
    return estimateTokensFallback(text);
}

/**
 * 精确 token 计算（使用 js-tiktoken BPE 编码）
 *
 * 使用 cl100k_base 编码器（GPT-4 / text-embedding 模型的 tokenizer）。
 * 如果 tiktoken 初始化失败，自动 fallback 到 CJK 启发式估算。
 */
export function estimateTokens(text: string): number {
    if (!text) return 0;
    if (text.length < TOKEN_CACHE_MIN_LENGTH) return encodeTokenCount(text);

    const cached = _tokenCache.get(text);
    if (cached !== undefined) {
        // 刷新 LRU 顺序
        _tokenCache.delete(text);
        _tokenCache.set(text, cached);
        return cached;
    }

    const count = encodeTokenCount(text);
    if (_tokenCache.size >= TOKEN_CACHE_MAX_ENTRIES) {
        const oldest = _tokenCache.keys().next();
        if (!oldest.done) _tokenCache.delete(oldest.value);
    }
    _tokenCache.set(text, count);
    return count;
}

/**
 * CJK 启发式 token 估算（fallback）
 *
 * - 英文/拉丁字符：约 4 字符 = 1 token
 * - CJK 字符：约 1.5 字符 = 1 token
 */
export function estimateTokensFallback(text: string): number {
    if (!text) return 0;

    const cjkMatches = text.match(CJK_REGEX);
    const cjkCount = cjkMatches ? cjkMatches.length : 0;
    const nonCjkCount = text.length - cjkCount;

    const cjkTokens = Math.ceil(cjkCount / 1.5);
    const nonCjkTokens = Math.ceil(nonCjkCount / 4);

    return cjkTokens + nonCjkTokens;
}

/**
 * 批量估算消息数组的 token 总数
 */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
    return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

function estimateMessageTokens(message: ChatMessage): number {
    const reasoning = message.reasoning;
    if (!reasoning) return estimateTokens(message.content);
    if (reasoning.tokenCount != null) {
        return estimateTokens(message.content) + reasoning.tokenCount;
    }
    if (reasoning.provider === "openai_chat") {
        return estimateTokens(message.content) + estimateTokens(reasoning.content);
    }
    if (reasoning.provider === "anthropic") {
        const thinkingText = reasoning.blocks
            .map((block) => typeof block.thinking === "string" ? block.thinking : "")
            .join("");
        return estimateTokens(message.content) + estimateTokens(thinkingText);
    }
    return estimateTokens(message.content);
}

// ─── Compaction 判断 ───

/** 触发 compaction / 强制裁剪的窗口占用比例 */
export const COMPACT_TRIGGER_RATIO = 0.85;

/**
 * 根据 LLMConfig 计算有效上下文窗口。
 * 优先使用 maxContextTokens，不存在时 fallback 到 budget.effectiveContextWindow。
 */
function resolveEffectiveWindow(
    budget: ContextBudget,
    llmConfig?: LLMConfig,
): number {
    if (llmConfig?.maxContextTokens && llmConfig.maxContextTokens > 0) {
        return llmConfig.maxContextTokens;
    }
    return budget.effectiveContextWindow;
}

/** 用目标模型的上下文窗口覆盖 budget.effectiveContextWindow */
function resolveEffectiveBudget(
    budget: ContextBudget,
    llmConfig?: LLMConfig,
): ContextBudget {
    const window = resolveEffectiveWindow(budget, llmConfig);
    if (window === budget.effectiveContextWindow) return budget;
    return { ...budget, effectiveContextWindow: window };
}

/**
 * 判断是否需要触发 compaction
 *
 * 触发条件：总 token 超过有效上下文窗口的 85%
 * 当传入 llmConfig 且其 maxContextTokens 已设置时，使用该值替代 budget 中的默认值。
 */
export function shouldCompact(
    messages: ChatMessage[],
    budget?: ContextBudget,
    llmConfig?: LLMConfig,
): boolean {
    if (messages.length === 0) return false;

    const effectiveBudget = budget ?? getConfiguredBudget();

    const effectiveWindow = resolveEffectiveWindow(effectiveBudget, llmConfig);
    const totalTokens = estimateMessagesTokens(messages);
    const threshold = effectiveWindow * COMPACT_TRIGGER_RATIO;

    log.debug("shouldCompact 检查", {
        totalTokens,
        threshold: Math.floor(threshold),
        effectiveWindow,
        messageCount: messages.length,
        triggered: totalTokens > threshold,
        source: llmConfig?.maxContextTokens ? `model(${llmConfig.model})` : "default",
    });

    return totalTokens > threshold;
}

// ─── 消息分类 ───

/**
 * 将消息数组分为四个区域
 *
 * ```
 * [0]       System Prompt
 * [1?]      Context Briefing (scope="context-briefing")
 * [2..N-K]  Candidates (压缩候选)
 * [N-K..N]  Recent (受保护近期消息)
 * ```
 */
export function classifyMessages(
    messages: ChatMessage[],
    budget: ContextBudget = DEFAULT_CONTEXT_BUDGET,
): ClassifiedMessages {
    if (messages.length === 0) {
        return { systemPrompt: null, briefing: null, candidates: [], recent: [] };
    }

    // 1. System prompt
    let systemPrompt: ChatMessage | null = null;
    let startIdx = 0;

    if (messages[0]?.role === "system") {
        systemPrompt = messages[0];
        startIdx = 1;
    }

    // 2. Briefing (如果存在)
    let briefing: ChatMessage | null = null;
    if (startIdx < messages.length && messages[startIdx]?.scope === "context-briefing") {
        briefing = messages[startIdx];
        startIdx++;
    }

    // 3. 计算 recent 的数量：至少 minRecentMessages 条，最多占 recentHistoryRatio 预算
    const remaining = messages.slice(startIdx);

    if (remaining.length === 0) {
        return { systemPrompt, briefing, candidates: [], recent: [] };
    }

    const recentTokenBudget = Math.floor(
        budget.effectiveContextWindow * budget.recentHistoryRatio,
    );

    // 从尾部向前扫描，直到达到 recentTokenBudget 或消息用完
    let recentCount = 0;
    let recentTokens = 0;

    for (let i = remaining.length - 1; i >= 0; i--) {
        const msgTokens = estimateMessageTokens(remaining[i]);
        if (recentCount >= budget.minRecentMessages && recentTokens + msgTokens > recentTokenBudget) {
            break;
        }
        recentCount++;
        recentTokens += msgTokens;
    }

    // 确保至少保留 minRecentMessages
    recentCount = Math.max(recentCount, Math.min(budget.minRecentMessages, remaining.length));

    const splitIdx = remaining.length - recentCount;
    const candidates = remaining.slice(0, splitIdx);
    const recent = remaining.slice(splitIdx);

    log.debug("classifyMessages", {
        total: messages.length,
        systemPrompt: !!systemPrompt,
        briefing: !!briefing,
        candidates: candidates.length,
        recent: recent.length,
        recentTokens,
    });

    return { systemPrompt, briefing, candidates, recent };
}

// ─── 话题保护 (M3.2) ───

/**
 * 识别需要保护的消息索引
 *
 * 保护规则：
 * 1. 最近 minRecentMessages 条消息始终受保护（由 classifyMessages 处理）
 * 2. reply chain：如果受保护的消息回复了更早的消息，该消息也受保护
 * 3. ENGAGED 话题的消息受保护（通过 engagedMessageIds 传入）
 */
export function identifyProtectedMessages(
    messages: ChatMessage[],
    options?: {
        /** 最近 N 条始终保护 */
        recentCount?: number;
        /** reply chain 索引映射（消息索引 → 它回复的消息索引） */
        replyChain?: Map<number, number>;
        /** ENGAGED 话题关联的消息索引集合 */
        engagedIndices?: Set<number>;
    },
): ProtectionResult {
    const recentCount = options?.recentCount ?? 6;
    const protectedIndices = new Set<number>();
    const reasons = new Map<number, string>();

    // 1. 最近 N 条
    for (let i = Math.max(0, messages.length - recentCount); i < messages.length; i++) {
        protectedIndices.add(i);
        reasons.set(i, "recent");
    }

    // 2. ENGAGED 话题
    if (options?.engagedIndices) {
        for (const idx of options.engagedIndices) {
            if (idx >= 0 && idx < messages.length) {
                protectedIndices.add(idx);
                reasons.set(idx, reasons.has(idx) ? reasons.get(idx)! + "+engaged" : "engaged");
            }
        }
    }

    // 3. Reply chain — 向前追溯
    if (options?.replyChain) {
        const toCheck = [...protectedIndices];
        while (toCheck.length > 0) {
            const idx = toCheck.pop()!;
            const repliedTo = options.replyChain.get(idx);
            if (repliedTo !== undefined && !protectedIndices.has(repliedTo)) {
                protectedIndices.add(repliedTo);
                reasons.set(repliedTo, "reply-chain");
                toCheck.push(repliedTo); // 继续追溯
            }
        }
    }

    log.debug("identifyProtectedMessages", {
        total: messages.length,
        protected: protectedIndices.size,
    });

    return { protectedIndices, reasons };
}

// ─── 强制裁剪（无 LLM 兜底） ───

/** 强制裁剪占位说明前缀 */
export const FORCE_TRIM_MARKER = "[Context 强制裁剪]";

/** 为占位说明预留的 token 数 */
const FORCE_TRIM_NOTE_RESERVE = 96;

/** 单条消息截断后至少保留的 token 数 */
const MIN_TOKENS_PER_MESSAGE = 64;

export interface ForceTrimOptions {
    replyChain?: Map<number, number>;
    engagedIndices?: Set<number>;
    /** 目标 session 模型，用于解析有效上下文窗口 */
    targetLlmConfig?: LLMConfig;
    /** 裁剪原因，写入占位说明便于排查 */
    reason?: string;
}

export interface ForceTrimResult {
    messages: ChatMessage[];
    /** 被直接丢弃的消息条数 */
    dropped: number;
    /** 是否有消息内容被截断 */
    truncated: boolean;
    /** 裁剪后是否仍然超预算（极端情况：system prompt 本身过大） */
    stillOverBudget: boolean;
}

/**
 * 强制裁剪：不调用任何 LLM，直接丢弃"本来要被 compact 掉"的消息。
 *
 * 用于 compact 模型不可用（未配置 / 调用失败 / 超时）时的兜底，
 * 保证上下文一定能回到预算内，不会因为摘要拿不到而永久卡在超窗状态。
 *
 * 裁剪顺序：
 * 1. 丢弃未受保护的压缩候选（等价于 compact 会摘要掉的部分）
 * 2. 仍超预算 → 从受保护的候选前部继续丢弃
 * 3. 仍超预算 → 从近期消息前部丢弃，但至少保留 minRecentMessages 条
 * 4. 仍超预算 → 逐条截断剩余消息内容
 *
 * system prompt 与现有 briefing 始终保留。
 */
export function forceTrim(
    messages: ChatMessage[],
    budget?: ContextBudget,
    options?: ForceTrimOptions,
): ForceTrimResult {
    if (messages.length === 0) {
        return { messages, dropped: 0, truncated: false, stillOverBudget: false };
    }

    const effectiveBudget = resolveEffectiveBudget(budget ?? getConfiguredBudget(), options?.targetLlmConfig);
    const limit = Math.floor(effectiveBudget.effectiveContextWindow * COMPACT_TRIGGER_RATIO);

    const classified = classifyMessages(messages, effectiveBudget);

    let candidateOffset = 0;
    if (classified.systemPrompt) candidateOffset++;
    if (classified.briefing) candidateOffset++;

    const protection = identifyProtectedMessages(messages, {
        recentCount: classified.recent.length,
        replyChain: options?.replyChain,
        engagedIndices: options?.engagedIndices,
    });

    // ─── Step 1: 丢弃未受保护的候选 ───
    // token 计数（尤其是 CJK 长文本的 BPE 编码）很贵，全程维护增量和，避免重复计数。
    let middle: WeightedMessage[] = [];
    let dropped = 0;
    for (let i = 0; i < classified.candidates.length; i++) {
        if (protection.protectedIndices.has(candidateOffset + i)) {
            middle.push(weigh(classified.candidates[i]));
        } else {
            dropped++;
        }
    }

    let recent = classified.recent.map(weigh);
    const headTokens = (classified.systemPrompt ? estimateMessageTokens(classified.systemPrompt) : 0)
        + (classified.briefing ? estimateMessageTokens(classified.briefing) : 0);
    let bodyTokens = sumTokens(middle) + sumTokens(recent);
    const overBudget = () => headTokens + bodyTokens + FORCE_TRIM_NOTE_RESERVE > limit;

    // ─── Step 2: 从受保护候选前部继续丢弃 ───
    while (overBudget() && middle.length > 0) {
        bodyTokens -= middle.shift()!.tokens;
        dropped++;
    }

    // ─── Step 3: 从近期消息前部丢弃，保留 minRecentMessages ───
    const minRecent = Math.max(1, Math.min(effectiveBudget.minRecentMessages, recent.length));
    while (overBudget() && recent.length > minRecent) {
        bodyTokens -= recent.shift()!.tokens;
        dropped++;
    }

    // ─── Step 4: 逐条截断 ───
    let truncated = false;
    if (overBudget()) {
        const available = Math.max(0, limit - headTokens - FORCE_TRIM_NOTE_RESERVE);
        const shrunk = shrinkMessagesToFit([...middle, ...recent], available);
        truncated = shrunk.truncated;
        if (truncated) {
            const middleCount = middle.length;
            middle = shrunk.messages.slice(0, middleCount);
            recent = shrunk.messages.slice(middleCount);
            bodyTokens = sumTokens(middle) + sumTokens(recent);
        }
    }

    if (dropped === 0 && !truncated) {
        return { messages, dropped: 0, truncated: false, stillOverBudget: overBudget() };
    }

    // ─── 重组 ───
    const note = buildForceTrimNote(dropped, truncated, options?.reason);
    const result: ChatMessage[] = [];

    if (classified.systemPrompt) {
        result.push(classified.systemPrompt);
    }
    if (classified.briefing) {
        result.push({ ...classified.briefing, content: `${classified.briefing.content}\n\n${note}` });
    } else {
        result.push({ role: "user", content: note, scope: "context-briefing" });
    }
    result.push(...middle.map((entry) => entry.message), ...recent.map((entry) => entry.message));

    const afterTokens = headTokens + bodyTokens + estimateTokens(note);
    const stillOverBudget = afterTokens > limit;
    log.warn("Context 强制裁剪完成", {
        reason: options?.reason,
        beforeMessages: messages.length,
        afterMessages: result.length,
        dropped,
        truncated,
        afterTokens,
        limit,
        stillOverBudget,
    });

    return { messages: result, dropped, truncated, stillOverBudget };
}

/** 消息 + 其 token 数（避免重复编码） */
interface WeightedMessage {
    message: ChatMessage;
    tokens: number;
}

function weigh(message: ChatMessage): WeightedMessage {
    return { message, tokens: estimateMessageTokens(message) };
}

function sumTokens(entries: WeightedMessage[]): number {
    return entries.reduce((sum, entry) => sum + entry.tokens, 0);
}

function buildForceTrimNote(dropped: number, truncated: boolean, reason?: string): string {
    const lines = [`${FORCE_TRIM_MARKER} 上下文已超出模型窗口，且无法生成摘要。`];
    if (dropped > 0) {
        lines.push(`- 已直接丢弃 ${dropped} 条较早的消息（内容不可恢复，没有摘要）。`);
    }
    if (truncated) {
        lines.push("- 保留下来的部分消息内容已被截断。");
    }
    if (reason) {
        lines.push(`- 原因：${reason}`);
    }
    lines.push("如果需要更早的上下文，请通过 memory 检索或平台历史 API 重新获取，不要凭猜测编造。");
    return lines.join("\n");
}

/** 把消息内容按平均配额截断到总预算内 */
function shrinkMessagesToFit(
    entries: WeightedMessage[],
    available: number,
): { messages: WeightedMessage[]; truncated: boolean } {
    if (entries.length === 0) {
        return { messages: entries, truncated: false };
    }

    const perMessage = Math.max(MIN_TOKENS_PER_MESSAGE, Math.floor(available / entries.length));
    let truncated = false;

    const result = entries.map((entry) => {
        if (entry.tokens <= perMessage) return entry;
        truncated = true;
        const content = truncateContentToTokens(entry.message.content, perMessage);
        return {
            message: { ...entry.message, content, reasoning: undefined },
            tokens: estimateTokens(content),
        };
    });

    return { messages: result, truncated };
}

function truncateContentToTokens(content: string, maxTokens: number, knownTokens?: number): string {
    const tokens = knownTokens ?? estimateTokens(content);
    if (tokens <= maxTokens) return content;

    const ratio = maxTokens / tokens;
    const keepChars = Math.max(80, Math.floor(content.length * ratio) - 60);
    if (keepChars >= content.length) return content;

    const headChars = Math.floor(keepChars * 0.6);
    const tailChars = keepChars - headChars;
    const omitted = content.length - keepChars;

    return `${content.slice(0, headChars)}\n…[强制裁剪：省略 ${omitted} 字]…\n${content.slice(content.length - tailChars)}`;
}

// ─── Compaction Prompt ───

let _compactionContextPrompt: string | null = null;

// 注册缓存清除回调
registerCacheClear(() => { _compactionContextPrompt = null; });

function getContextCompactionPrompt(): string {
    if (!_compactionContextPrompt) {
        const content = loadPromptFile("memory/context-compaction.md");
        if (content) {
            _compactionContextPrompt = content.trim();
        } else {
            _compactionContextPrompt = `你是一个上下文压缩助手。请将以下对话历史压缩为结构化的 Context Briefing。

要求：
1. 按话题分段总结，保留关键信息和结论
2. 标注每个话题的参与者
3. 提取重要的事实和待续话题
4. 使用中文输出

输出格式：
## 之前的对话摘要
- [话题标签] 参与者讨论了什么，结论是什么
## 关键事实
- 具体的事实信息
## 活跃待续话题
- 正在进行的讨论`;
        }
    }
    return _compactionContextPrompt;
}

// ─── Compaction 执行 (M3.3) ───

/**
 * 执行 Context Compaction
 *
 * 流程：
 * 1. classifyMessages 分段
 * 2. identifyProtectedMessages 标记保护
 * 3. 从 candidates 中筛出未受保护的消息
 * 4. 调用 cheap model 生成 Context Briefing
 * 5. 重组消息数组：[System Prompt] + [Briefing] + [受保护候选] + [Recent]
 *
 * 如果未超过预算，原样返回不做压缩。
 *
 * 摘要模型不可用（未配置 / 调用失败 / 未产出内容）时，
 * 退化为 forceTrim() 强制裁剪，绝不会把超窗的上下文原样抛回给调用方——
 * 否则 session / meta 会在超窗状态下反复失败且永远等不到压缩。
 */
export async function compact(
    messages: ChatMessage[],
    llmConfigs: LLMConfig[],
    budget?: ContextBudget,
    options?: {
        replyChain?: Map<number, number>;
        engagedIndices?: Set<number>;
        /** 用于判断目标 session 是否超窗；摘要生成仍使用 llmConfigs。 */
        targetLlmConfig?: LLMConfig;
    },
): Promise<ChatMessage[]> {
    const resolvedBudget = budget ?? getConfiguredBudget();

    // 使用目标 session 模型的 maxContextTokens 覆盖 budget；摘要生成模型可走独立 compact 路由。
    const targetConfig = options?.targetLlmConfig ?? llmConfigs[0];
    const effectiveBudget = resolveEffectiveBudget(resolvedBudget, targetConfig);
    const trimOptions: ForceTrimOptions = {
        replyChain: options?.replyChain,
        engagedIndices: options?.engagedIndices,
        targetLlmConfig: targetConfig,
    };

    // 不需要压缩时原样返回
    if (!shouldCompact(messages, effectiveBudget, targetConfig)) {
        log.debug("compact: 未超预算，跳过压缩");
        return messages;
    }

    try {
        return await compactWithBriefing(messages, llmConfigs, effectiveBudget, options, trimOptions);
    } catch (err) {
        log.error("compact: 压缩流程异常，退化为强制裁剪", { error: String(err) });
        return forceTrim(messages, effectiveBudget, {
            ...trimOptions,
            reason: `压缩流程异常：${String(err).slice(0, 160)}`,
        }).messages;
    }
}

async function compactWithBriefing(
    messages: ChatMessage[],
    llmConfigs: LLMConfig[],
    effectiveBudget: ContextBudget,
    options: {
        replyChain?: Map<number, number>;
        engagedIndices?: Set<number>;
        targetLlmConfig?: LLMConfig;
    } | undefined,
    trimOptions: ForceTrimOptions,
): Promise<ChatMessage[]> {
    const classified = classifyMessages(messages, effectiveBudget);

    // 无候选消息可压缩 —— 超窗只能来自 system prompt / briefing / 尾部，交给强制裁剪
    if (classified.candidates.length === 0) {
        log.warn("compact: 无候选消息可压缩，改为强制裁剪");
        return forceTrim(messages, effectiveBudget, {
            ...trimOptions,
            reason: "没有可摘要的候选消息",
        }).messages;
    }

    // 计算候选消息在原数组中的偏移
    let candidateOffset = 0;
    if (classified.systemPrompt) candidateOffset++;
    if (classified.briefing) candidateOffset++;

    // 话题保护
    const protection = identifyProtectedMessages(messages, {
        recentCount: classified.recent.length,
        replyChain: options?.replyChain,
        engagedIndices: options?.engagedIndices,
    });

    // 分离候选中的受保护和未保护消息
    const unprotectedCandidates: ChatMessage[] = [];
    const protectedCandidates: ChatMessage[] = [];

    for (let i = 0; i < classified.candidates.length; i++) {
        const globalIdx = candidateOffset + i;
        if (protection.protectedIndices.has(globalIdx)) {
            protectedCandidates.push(classified.candidates[i]);
        } else {
            unprotectedCandidates.push(classified.candidates[i]);
        }
    }

    // 全部候选都受保护 —— 保护规则让位于"必须回到预算内"
    if (unprotectedCandidates.length === 0) {
        log.warn("compact: 所有候选消息均受保护，改为强制裁剪");
        return forceTrim(messages, effectiveBudget, {
            ...trimOptions,
            reason: "所有候选消息均受保护",
        }).messages;
    }

    // 没有可用的摘要模型 —— 直接丢弃本来要被 compact 掉的部分
    if (llmConfigs.length === 0) {
        log.warn("compact: 没有可用的 compact 模型，改为强制裁剪", {
            unprotected: unprotectedCandidates.length,
        });
        return forceTrim(messages, effectiveBudget, {
            ...trimOptions,
            reason: "没有可用的 compact 模型",
        }).messages;
    }

    log.info("开始 Context Compaction", {
        total: messages.length,
        candidates: classified.candidates.length,
        unprotected: unprotectedCandidates.length,
        protected: protectedCandidates.length,
        recent: classified.recent.length,
    });

    // 生成 Context Briefing
    const briefing = await generateBriefing(
        unprotectedCandidates,
        classified.briefing?.content, // 已有的 briefing 也传入合并
        llmConfigs,
        effectiveBudget,
    );

    // 摘要模型坏了 —— 强制裁剪，而不是把超窗上下文原样返回
    if (!briefing.ok) {
        return forceTrim(messages, effectiveBudget, {
            ...trimOptions,
            reason: `compact 模型不可用：${briefing.error.slice(0, 160)}`,
        }).messages;
    }

    // 重组消息数组
    const result: ChatMessage[] = [];

    // [0] System Prompt
    if (classified.systemPrompt) {
        result.push(classified.systemPrompt);
    }

    // [1] Context Briefing
    result.push({
        role: "user",
        content: briefing.content,
        scope: "context-briefing",
    });

    // [2..] 受保护的候选消息（时间顺序保留）
    result.push(...protectedCandidates);

    // [N-K..N] 近期消息
    result.push(...classified.recent);

    const beforeTokens = estimateMessagesTokens(messages);
    const afterTokens = estimateMessagesTokens(result);

    log.info("Context Compaction 完成", {
        beforeMessages: messages.length,
        afterMessages: result.length,
        beforeTokens,
        afterTokens,
        compressed: messages.length - result.length,
        tokensSaved: beforeTokens - afterTokens,
    });

    // 摘要生成成功但仍然超窗（受保护消息或尾部本身过大）→ 继续强制裁剪
    if (shouldCompact(result, effectiveBudget, options?.targetLlmConfig)) {
        log.warn("compact: 摘要后仍超预算，追加强制裁剪", { afterTokens });
        return forceTrim(result, effectiveBudget, {
            ...trimOptions,
            replyChain: undefined,
            engagedIndices: undefined,
            reason: "生成摘要后仍超出模型窗口",
        }).messages;
    }

    return result;
}

type BriefingOutcome =
    | { ok: true; content: string }
    | { ok: false; error: string };

/**
 * 调用 cheap model 生成 Context Briefing。
 *
 * 失败时不再返回"统计式假摘要"，而是显式报错，
 * 让调用方走 forceTrim 强制裁剪路径。
 */
async function generateBriefing(
    messagesToCompress: ChatMessage[],
    existingBriefing: string | undefined,
    llmConfigs: LLMConfig[],
    budget: ContextBudget,
): Promise<BriefingOutcome> {
    // 拼接要压缩的对话文本
    const conversationText = messagesToCompress
        .map(m => `[${m.role}] ${m.content}`)
        .join("\n\n");

    const prompt = getContextCompactionPrompt();

    const userContent = existingBriefing
        ? `以下是之前的 Context Briefing（请在此基础上更新）：\n\n${existingBriefing}\n\n---\n\n以下是新的对话记录，请整合到 Briefing 中：\n\n${conversationText}`
        : `请将以下对话记录压缩为 Context Briefing：\n\n${conversationText}`;

    const briefingMessages: ChatMessage[] = [
        { role: "system", content: prompt },
        { role: "user", content: userContent },
    ];

    try {
        const response = await callLLMWithFallback(briefingMessages, llmConfigs, { caller: "context-manager", timeoutMs: resolveComponentTimeout("compact") });
        const briefing = response.content.trim();

        if (!briefing) {
            log.error("Context Briefing 生成失败：模型返回空内容");
            return { ok: false, error: "摘要模型返回空内容" };
        }

        // 检查 briefing 是否超过预算
        const briefingTokens = estimateTokens(briefing);
        if (briefingTokens > budget.maxBriefingTokens) {
            log.warn("Context Briefing 超过预算，截断", {
                tokens: briefingTokens,
                max: budget.maxBriefingTokens,
            });
            // 粗略截断（按比例取前 N 字符）
            const ratio = budget.maxBriefingTokens / briefingTokens;
            const maxChars = Math.floor(briefing.length * ratio);
            return {
                ok: true,
                content: `[Context Briefing — 上下文摘要]\n\n${briefing.slice(0, maxChars)}\n\n...[摘要因长度限制被截断]`,
            };
        }

        return { ok: true, content: `[Context Briefing — 上下文摘要]\n\n${briefing}` };
    } catch (err) {
        log.error("Context Briefing 生成失败，将强制裁剪", { error: String(err) });
        return { ok: false, error: String(err) };
    }
}

/**
 * 合并 ContextBudget 配置，用 partial 覆盖默认值
 */
export function mergeContextBudget(
    partial?: Partial<ContextBudget>,
): ContextBudget {
    if (!partial) return { ...DEFAULT_CONTEXT_BUDGET };
    return {
        ...DEFAULT_CONTEXT_BUDGET,
        ...partial,
    };
}
