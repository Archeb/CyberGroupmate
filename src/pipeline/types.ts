/**
 * phase6/types.ts — Phase 6 共享类型定义
 *
 * 定义 Air-Reading Engine、Recording Pipeline、Engaged Topic Handler、
 * Model Router、Dry-Run System 所需的全部共享类型。
 *
 * 所有 Phase 6 模块从此文件导入类型，保持一致性。
 */

// ─── 基础消息类型 ───

/** 标准化消息结构（从 Telegram 事件转换而来） */
export interface Message {
    /** 消息 ID */
    id: string;
    /** 所属群/聊天 ID */
    chatId: string;
    /** 发送者 user_id */
    senderId: string;
    /** 发送者显示名称 */
    senderName: string;
    /** 发送者平台用户名（如 Telegram @username） */
    senderUsername?: string;
    /** 消息文本 */
    text: string;
    /** 回复目标消息 ID（如果有） */
    replyToMessageId?: string;
    /** 消息时间戳（毫秒） */
    timestamp: number;
    /** 所属 scene / app */
    scene?: string;
    /** 原始平台类型 */
    platform?: string;
    /** adapter 判定的聊天类型，如 private/supergroup/channel */
    chatType?: string;
    /** 平台是否已判定为私聊 */
    isDirectMessage?: boolean;
    /** 平台是否已检测到明确提及 agent */
    mentionsAgent?: boolean;
    /** 内部标记：该消息已走过 FAST_PATH，即时回复侧已处理 */
    _viaFastPath?: boolean;
    /** 内部标记：是否歧义归属 */
    _ambiguous?: boolean;
    /** 媒体类型: "photo" | "sticker" | "video" | "document" | "animation" | "other" */
    mediaType?: string;
    /** 媒体元数据 JSON（含 fileId, uniqueFileId, emoji 等） */
    mediaInfo?: string;
    /** 原始平台消息对象（供 adapter.downloadMedia 回调使用） */
    rawMessage?: unknown;
}

// ─── 话题状态 ───

/** 话题状态机的所有可能状态 */
export type TopicState =
    | "ACTIVE"             // Recording Pipeline 持续有消息流入
    | "ENGAGED"            // Agent 已介入，对话模式
    | "EXITING"            // 退出中，可能还有最后一条消息
    | "COOLDOWN"           // 冷却期，不主动介入
    | "IGNORED"            // Triage 判定不介入
    | "STALE"              // 15 分钟无新消息
    | "ARCHIVED";          // 2 小时无新消息，归入长期记忆

// ─── Triage 决策 ───

/** 话题级 Triage 的结构化输出 */
export interface TriageDecision {
    /** 是否应该介入 */
    should_intervene: boolean;
    /** 判断理由 */
    reason: string;
}

// ─── 退出信号 ───

/** 退出信号类型（按优先级排序 P0 最高） */
export type ExitSignalType =
    | "MAX_TURNS"           // P0: 硬上限
    | "SOCIAL_PRESSURE"     // P1: 社交压力（"闭嘴"、多人不耐烦）
    | "IDENTITY_PROBING"    // P2: 身份探测（试探是否是 bot）
    | "TIMEOUT"             // P3: 超时（3min 无新消息）
    | "DIMINISHING_RETURNS" // P4: 递减回报（engagement 下降）
    | "TOPIC_DRIFT"         // P5: 话题漂移
    | "CROWDED_OUT"         // P6: 被其他话题冲走
    | "NATURAL_CONCLUSION"; // quickTriage 判定自然结束

/** 退出信号 */
export interface ExitSignal {
    type: ExitSignalType;
    confidence: number;
    reason: string;
    timestamp: number;
}

/** 退出行为风格 */
export type ExitStyle =
    | "NATURAL_END"          // 有收尾感的最后一句话
    | "FADE_OUT"             // 简短回应后不再说话
    | "GRACEFUL_REDIRECT"    // 把话题抛回群友
    | "SILENT_WITHDRAWAL"    // 直接不回
    | "GRADUAL_WITHDRAWAL";  // 逐渐降低回复频率

// ─── 话题核心数据结构 ───

/** 话题注册表核心数据结构 */
export interface Topic {
    /** topic_<ulid> */
    id: string;
    /** 所属群组 */
    chatId: string;
    /** 3-5 词的话题标签（LLM 生成） */
    label: string;
    /** 关键词集合 */
    keywords: string[];
    /** 参与者 user_id 集合 */
    participantIds: Set<string>;
    /** 属于此话题的消息 ID 列表 */
    messageIds: string[];
    /** 当前状态 */
    state: TopicState;
    /** 最近一次 Triage 的结果 */
    decision?: TriageDecision;
    /** 话题演变链（流变时指向原话题） */
    parentTopicId?: string;
    /** 上一次 IGNORED 的原因（用于流变继承） */
    ignoreReason?: string;
    /** 流变时的冷却增强标记 */
    cooldownBoost?: boolean;

    // ─── 时间戳 ───
    /** 创建时间（毫秒） */
    createdAt: number;
    /** 最后活跃时间（毫秒） */
    lastActivityAt: number;
    /** 最后一次 Triage 时间（毫秒） */
    lastTriagedAt?: number;

    // ─── 对话模式专用字段（state=ENGAGED 时使用） ───
    /** agent 已回复轮次 */
    turnCount: number;
    /** 最大回复轮次（动态计算） */
    maxTurns: number;
    /** agent 最后一次回复时间（毫秒） */
    lastAgentReplyAt?: number;
    /** 主要对话对象 user_id */
    primaryInterlocutor?: string;
    /** 待处理消息缓冲 */
    pendingMessages: Message[];
    /** 累积的退出信号 */
    exitSignals: ExitSignal[];
    /** 连续不相关消息计数 */
    irrelevantStreak: number;
    /** 下一条回复的特殊指示 */
    nextReplyInstruction?: "wrap_up" | "minimal_acknowledgment" | "redirect_to_others";
    /** 下条回复后退出标记 */
    exitAfterNextReply?: boolean;

    // ─── 统计 ───
    /** 话题内总消息数 */
    messageCount: number;

    // ─── 上下文 ───
    /** 最近几条消息的摘要（LLM 生成，给 Triage 用） */
    recentContext: string;
    /** 上一轮 Triage 生成的一句话摘要（跨 flush 持久化） */
    lastSummary?: string;
}

// ─── quickTriage 相关类型 ───

/** quickTriage 的配置 */
export interface QuickTriageOptions {
    /** 是否检测身份探测 */
    checkIdentityProbing: boolean;
    /** 是否检查应否继续回复 */
    checkShouldContinue: boolean;
    /** 是否检查自然结束 */
    checkNaturalConclusion: boolean;
    /** 是否生成回复方向提示 */
    generateReplyHint: boolean;
}

/** quickTriage 的结果 */
export interface QuickTriageResult {
    /** 身份探测置信度 0-1 */
    identityProbing: number;
    /** 是否应该继续回复 */
    shouldContinue: boolean;
    /** 对话是否自然结束 */
    naturalConclusion: boolean;
    /** 不继续的理由 */
    reason: string;
    /** 回复方向提示（给 Reply Pipeline 用） */
    replyHint: string;
}

// ─── Fast Router 相关类型 ───

/** 消息路由分类结果 */
export type RouteResult =
    | { type: "FAST_PATH"; message: Message; reason: string }
    | { type: "ENGAGED"; message: Message; topicId: string }
    | { type: "RECORDING"; message: Message };

/** 消息与 ENGAGED 话题的关联程度 */
export type EngagedRelevance =
    | "CLEARLY_RELATED"
    | "AMBIGUOUS"
    | "CLEARLY_UNRELATED";

// ─── Model Router 相关类型 ───

/** Model Router 的路由结果 */
export interface ModelRouteResult {
    /** 推荐使用的模型名称 */
    model: string;
    /** 对应的 LLM 配置覆盖 */
    overrides: {
        model?: string;
        temperature?: number;
        maxTokens?: number;
    };
}

/** Model Router 的路由规则 */
export interface ModelRouteRule {
    /** 规则名称（调试用） */
    name: string;
    /** 匹配条件 */
    match: {
        isDirect?: boolean;        // 直接 @ 或私聊
        isComplex?: boolean;       // 复杂问题
    };
    /** 路由结果 */
    route: {
        model: string;
    };
}

// ─── Dry-Run 相关类型 ───

/** Dry-Run 配置 */
export interface DryRunConfig {
    /** 聊天 ID */
    chatId: string;
    /** 拉取最近 N 天的历史消息 */
    daysBack: number;
    /** 使用哪个模型 */
    model: string;
    /** 是否实际发送消息 */
    send: boolean;
    /** 消息来源：file = JSON 文件, live = 实时运行 */
    source: "file" | "live";
    /** JSON 文件路径（source=file 时） */
    filePath?: string;
    /** Memory V2 数据库路径（默认 workspace/dry-run-memory.db） */
    memoryDbPath?: string;
    /** 是否在处理完后触发 Reflection */
    reflect?: boolean;
}

/** Dry-Run 单条决策记录 */
export interface DryRunDecision {
    triggerMessage: { from: string; text: string; time: string };
    decision: "reply" | "ignore";
    reason: string;
    generatedReply?: string;
    pipelineTrace: string[];
}

/** Dry-Run 评估结果 */
export interface DryRunResult {
    totalMessages: number;
    /** agent 决定回复的消息数 */
    wouldReply: number;
    /** agent 决定沉默的消息数 */
    wouldIgnore: number;
    /** 每条决定回复的消息的详情 */
    decisions: DryRunDecision[];
    /** 总 token 消耗 */
    totalTokens: number;
    /** 总耗时 */
    totalTimeMs: number;
    /** Memory V2 统计（如果启用了 memory 写入） */
    memoryStats?: {
        topics: number;
        facts: number;
        messages: number;
        persons: number;
        profiles: number;
        dbPath: string;
    };
    /** Reflection 结果（如果启用了 reflect） */
    reflectionResults?: Array<{
        chatId: string;
        topicsSummary: number;
        personUpdates: number;
        newFacts: number;
        mergedEpisodes: number;
        insights: string;
    }>;
}

// ─── Recording Pipeline LLM 输出类型 ───

/** Step 1: 话题聚类 LLM 输出 */
export interface TopicClusteringResult {
    /** 每条消息的话题归属 */
    assignments: Array<{
        messageId: string;
        topicId: string;        // 已有话题 ID 或 "NEW_n"
        topicLabel?: string;    // 仅新话题需要
        keywords?: string[];    // 仅新话题需要
    }>;
    /** 话题流变检测 */
    evolutions: Array<{
        parentTopicId: string;
        newTopicLabel: string;
        reason: string;
    }>;
}

/** Step 2: 话题摘要 + Triage LLM 输出 */
export interface TopicSummaryTriageResult {
    topics: Array<{
        topicId: string;
        summary: string;
        /** Triage 结果 */
        should_intervene: boolean;
        reason: string;
    }>;
}
