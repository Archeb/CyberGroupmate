import { createLogger } from "../core/logger.js";
import { callLLM, type ChatMessage } from "../core/llm.js";
import { loadConfig, resolveComponentTimeout, type LLMConfig } from "../core/config.js";
import { readFileSync } from "node:fs";
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
 * 精确 token 计算（使用 js-tiktoken BPE 编码）
 *
 * 使用 cl100k_base 编码器（GPT-4 / text-embedding 模型的 tokenizer）。
 * 如果 tiktoken 初始化失败，自动 fallback 到 CJK 启发式估算。
 */
export function estimateTokens(text: string): number {
    if (!text) return 0;

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
    return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

// ─── Compaction 判断 ───

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
    const threshold = effectiveWindow * 0.85;

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
        const msgTokens = estimateTokens(remaining[i].content);
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

// ─── Compaction Prompt ───

const PROMPTS_DIR = join(process.cwd(), "system-prompts", "memory");
let _compactionContextPrompt: string | null = null;

function getContextCompactionPrompt(): string {
    if (!_compactionContextPrompt) {
        try {
            _compactionContextPrompt = readFileSync(
                join(PROMPTS_DIR, "context-compaction.md"), "utf-8",
            ).trim();
        } catch {
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
 */
export async function compact(
    messages: ChatMessage[],
    llmConfig: LLMConfig,
    budget?: ContextBudget,
    options?: {
        replyChain?: Map<number, number>;
        engagedIndices?: Set<number>;
    },
): Promise<ChatMessage[]> {
    const resolvedBudget = budget ?? getConfiguredBudget();

    // 使用 llmConfig 中的 maxContextTokens 覆盖 budget 的 effectiveContextWindow
    const effectiveBudget = llmConfig.maxContextTokens && llmConfig.maxContextTokens > 0
        ? { ...resolvedBudget, effectiveContextWindow: llmConfig.maxContextTokens }
        : resolvedBudget;

    // 不需要压缩时原样返回
    if (!shouldCompact(messages, effectiveBudget, llmConfig)) {
        log.debug("compact: 未超预算，跳过压缩");
        return messages;
    }

    const classified = classifyMessages(messages, effectiveBudget);

    // 无候选消息可压缩
    if (classified.candidates.length === 0) {
        log.debug("compact: 无候选消息可压缩");
        return messages;
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

    // 如果没有可压缩的消息
    if (unprotectedCandidates.length === 0) {
        log.debug("compact: 所有候选消息均受保护，跳过压缩");
        return messages;
    }

    log.info("开始 Context Compaction", {
        total: messages.length,
        candidates: classified.candidates.length,
        unprotected: unprotectedCandidates.length,
        protected: protectedCandidates.length,
        recent: classified.recent.length,
    });

    // 生成 Context Briefing
    const briefingContent = await generateBriefing(
        unprotectedCandidates,
        classified.briefing?.content, // 已有的 briefing 也传入合并
        llmConfig,
        effectiveBudget,
    );

    // 重组消息数组
    const result: ChatMessage[] = [];

    // [0] System Prompt
    if (classified.systemPrompt) {
        result.push(classified.systemPrompt);
    }

    // [1] Context Briefing
    result.push({
        role: "user",
        content: briefingContent,
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

    return result;
}

/**
 * 调用 cheap model 生成 Context Briefing
 */
async function generateBriefing(
    messagesToCompress: ChatMessage[],
    existingBriefing: string | undefined,
    llmConfig: LLMConfig,
    budget: ContextBudget,
): Promise<string> {
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
        const response = await callLLM(briefingMessages, llmConfig, { caller: "context-manager", timeoutMs: resolveComponentTimeout("compact") });
        const briefing = response.content.trim();

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
            return `[Context Briefing — 上下文摘要]\n\n${briefing.slice(0, maxChars)}\n\n...[摘要因长度限制被截断]`;
        }

        return `[Context Briefing — 上下文摘要]\n\n${briefing}`;
    } catch (err) {
        log.error("Context Briefing 生成失败，回退到简单摘要", { error: String(err) });

        // 回退：简单统计摘要
        const msgCount = messagesToCompress.length;
        const roles = messagesToCompress.reduce((acc, m) => {
            acc[m.role] = (acc[m.role] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);

        return `[Context Briefing — 上下文摘要]\n\n在此之前有 ${msgCount} 条对话记录已被压缩（${roles.user ?? 0} 条用户消息，${roles.assistant ?? 0} 条助手消息）。\n\n${existingBriefing ? `之前的摘要：${existingBriefing}` : ""}`;
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
