/**
 * config.ts — 统一配置管理器
 *
 * 从 config.yaml 加载配置。
 *
 * LLM 配置使用 Profile 体系：
 *   llm_profiles: 定义多个命名 LLM 配置
 *   model_tiers: cheap/mid/sota 引用 profile 名称
 */

import { readFileSync, existsSync } from "node:fs";
import { parse as parseYAML } from "yaml";

// ─── 类型定义 ───

export interface LLMConfig {
    provider: "anthropic" | "openai";
    baseUrl: string;
    apiKey: string;
    model: string;
    temperature: number;
    maxTokens: number;
    /** Gemini thinking level: "none" | "low" | "medium" | "high" */
    thinkingLevel?: string;
    /** 此 profile 是否支持多模态图片输入。默认 false */
    vision?: boolean;
}

/** 相似度度量方法 */
export type SimilarityMetric = "cosine" | "dot_product" | "euclidean" | "manhattan";

/** Embedding 配置 */
export interface EmbeddingConfig {
    /** 提供者：openai 兼容 API 或本地 hash-based */
    provider: "openai" | "local";
    /** API base URL（OpenAI 兼容） */
    baseUrl: string;
    /** API key */
    apiKey: string;
    /** 模型名称 */
    model: string;
    /** 向量维度 */
    dimensions: number;
    /** 相似度度量方法 */
    similarityMetric: SimilarityMetric;
}

/** 模型层级 — tier name → profile name */
export interface ModelTiersConfig {
    cheap: string;
    mid: string;
    sota: string;
    [key: string]: string;
}

export interface PersonaConfig {
    name: string;
    description: string;
}

export interface NotificationConfig {
    /** 触发 Q3 即时入队 + Observer 提权的关键词（agent 名字等） */
    mentionKeywords: string[];
}

export interface TelegramConfig {
    mode: "bot" | "userbot";
    botToken: string;
    apiId: string;
    apiHash: string;
    phone: string;
}

export interface ReflectionExternalConfig {
    /** LLM temperature for reflection calls (default: 0.3) */
    temperature?: number;
    /** Max output tokens for reflection LLM call (default: 16384) */
    maxTokens?: number;
    /** Override model for reflection (default: uses cheap tier model) */
    model?: string;
    /** Silence threshold in seconds before triggering reflection (default: 7200 = 2h) */
    silenceThreshold?: number;
    /** Max interval in seconds between reflections, even if group is active (default: 86400 = 24h) */
    maxInterval?: number;
    /** Check interval in seconds for silence detection (default: 300 = 5min) */
    checkInterval?: number;
    /** Merge thresholds in days */
    mergeThresholds?: {
        episodeToWeek?: number;
        weekToMonth?: number;
        monthToQuarter?: number;
        quarterToYear?: number;
    };
    /** Tier limits override */
    tierLimits?: Record<number, {
        maxTraits?: number;
        maxInterests?: number;
        episodeDays?: number;
    }>;
    /** Agent awake hours [start, end] in 24h format, e.g. [8, 24] */
    awakeHours?: [number, number];
}

/** Context Compaction 预算配置 */
export interface ContextBudgetConfig {
    /** 模型的有效上下文窗口（token 数）。默认 32000 */
    effectiveContextWindow?: number;
    /** 分配给 system prompt 的预算比例。默认 0.20 */
    systemPromptRatio?: number;
    /** 分配给 context briefing 的预算比例。默认 0.15 */
    briefingRatio?: number;
    /** 分配给 recent history 的预算比例。默认 0.50 */
    recentHistoryRatio?: number;
    /** 预留给当前轮次 output 的预算（固定值）。默认 4096 */
    outputReserve?: number;
    /** 最少保留的近期消息条数。默认 6 */
    minRecentMessages?: number;
    /** Context Briefing 最大 token 数。默认 3000 */
    maxBriefingTokens?: number;
}

/** Subagent 系统外部配置（从 config.yaml 加载） */
export interface SubagentExternalConfig {
    maxSandboxInstances?: number;
    sandboxIdleTimeout?: number;
    pollInterval?: number;
    alertEngagementThreshold?: number;
    cosineDecay?: {
        defaultCyclePeriod?: number;
    };
    fastPath?: {
        defaultMaxReplies?: number;
        defaultExpiresMinutes?: number;
        engagementThreshold?: number;
    };
    stickiness?: Record<string, {
        priorityMultiplier?: number;
        depthCyclePeriod?: number;
    }>;
    stickinessThresholds?: {
        upgrade?: {
            strangerToAcquaintance?: number;
            acquaintanceToFamiliar?: number;
            familiarToCore?: number;
        };
        downgrade?: {
            coreToFamiliar?: number;
            familiarToAcquaintance?: number;
            acquaintanceToStranger?: number;
        };
    };
    attentionQueue?: {
        timeDecayPerSecond?: number;
        maxSize?: number;
    };
    observer?: {
        engagementWindowMs?: number;
    };
    mainLoop?: {
        maxAttendsPerTick?: number;
    };
    decision?: {
        batchThreshold?: number;
        noneThreshold?: number;
        batchMessageThreshold?: number;
    };
    globalState?: {
        maxRecentDecisions?: number;
        autoSaveInterval?: number;
    };
    codeAct?: {
        maxExecutionTimeMs?: number;
        maxSessionMessages?: number;
    };
}

/** Vision 处理配置 */
export interface VisionConfig {
    /** 以 file 形式发送的大图压缩阈值（长边像素）。默认 1024 */
    maxImageSize?: number;
    /** 单轮上下文最多内联几张图片，超出走 vision 描述。默认 3 */
    maxImagesPerContext?: number;
    /** Sticker 处理模式。默认 "emoji_only" */
    stickerMode?: "vision_each" | "vision_cache" | "emoji_only";
}

/** Dashboard 外部配置 */
export interface DashboardExternalConfig {
    /** 是否启用。默认 true */
    enabled?: boolean;
    /** HTTP 端口。默认 6767 */
    port?: number;
    /** 认证 Token */
    token?: string;
}

export interface AppConfig {
    llmProfiles: Record<string, LLMConfig>;
    modelTiers: ModelTiersConfig;
    persona: PersonaConfig;
    /** Agent 所处时区 (IANA 标识符，如 "Asia/Shanghai")。影响 LLM prompt 中的时间展示和作息判断。 */
    timezone?: string;
    telegram: TelegramConfig;
    notification: NotificationConfig;
    reflection: ReflectionExternalConfig;
    contextBudget?: ContextBudgetConfig;
    embedding: EmbeddingConfig;
    subagent?: SubagentExternalConfig;
    dashboard?: DashboardExternalConfig;
    vision?: VisionConfig;
}

// ─── 默认值 ───

const DEFAULT_LLM: LLMConfig = {
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o",
    temperature: 0.7,
    maxTokens: 8192,
};

const DEFAULT_EMBEDDING: EmbeddingConfig = {
    provider: "local",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "text-embedding-3-small",
    dimensions: 128,
    similarityMetric: "cosine",
};

// ─── 配置加载 ───

let _cached: AppConfig | null = null;

export function loadConfig(configPath?: string, forceReload?: boolean): AppConfig {
    if (_cached && !forceReload) return _cached;

    let fileConfig: Record<string, unknown> = {};
    const path = configPath ?? "config.yaml";

    if (existsSync(path)) {
        try {
            const raw = readFileSync(path, "utf-8");
            fileConfig = parseYAML(raw) ?? {};
        } catch (err) {
            console.error(`[Config] config.yaml 解析错误: ${err instanceof Error ? err.message : err}`);
        }
    }

    // ─── LLM Profiles ───
    const llmProfiles: Record<string, LLMConfig> = {};
    const fileProfiles = (fileConfig.llm_profiles ?? {}) as Record<string, Record<string, unknown>>;

    for (const [name, raw] of Object.entries(fileProfiles)) {
        llmProfiles[name] = parseLLMProfile(raw);
    }

    if (Object.keys(llmProfiles).length === 0) {
        llmProfiles["default"] = { ...DEFAULT_LLM };
    }

    // ─── Model Tiers ───
    const fileTiers = (fileConfig.model_tiers ?? {}) as Record<string, unknown>;
    const firstProfile = Object.keys(llmProfiles)[0];

    const modelTiers: ModelTiersConfig = {
        cheap: str(fileTiers.cheap) ?? firstProfile,
        mid: str(fileTiers.mid) ?? firstProfile,
        sota: str(fileTiers.sota) ?? firstProfile,
    };
    for (const [k, v] of Object.entries(fileTiers)) {
        if (!["cheap", "mid", "sota"].includes(k) && typeof v === "string") {
            modelTiers[k] = v;
        }
    }

    // ─── 其他配置 ───
    const filePersona = (fileConfig.persona ?? {}) as Record<string, unknown>;
    const fileTG = (fileConfig.telegram ?? {}) as Record<string, unknown>;
    const fileNotification = (fileConfig.notification ?? {}) as Record<string, unknown>;
    const fileReflection = (fileConfig.reflection ?? {}) as Record<string, unknown>;
    const fileMerge = (fileReflection.merge_thresholds ?? {}) as Record<string, unknown>;
    const fileTierLimits = (fileReflection.tier_limits ?? {}) as Record<string, unknown>;
    const fileContextBudget = (fileConfig.context_budget ?? {}) as Record<string, unknown>;

    // 解析 tierLimits
    const parsedTierLimits: ReflectionExternalConfig["tierLimits"] = {};
    for (const [tier, val] of Object.entries(fileTierLimits)) {
        const t = Number(tier);
        if (t >= 1 && t <= 4 && typeof val === "object" && val !== null) {
            const v = val as Record<string, unknown>;
            parsedTierLimits[t] = {
                maxTraits: v.max_traits != null ? num(v.max_traits, 10) : undefined,
                maxInterests: v.max_interests != null ? num(v.max_interests, 15) : undefined,
                episodeDays: v.episode_days != null ? num(v.episode_days, 14) : undefined,
            };
        }
    }

    // 解析 contextBudget
    const parsedContextBudget: ContextBudgetConfig | undefined = Object.keys(fileContextBudget).length > 0 ? {
        effectiveContextWindow: fileContextBudget.effective_context_window != null ? num(fileContextBudget.effective_context_window, 32000) : undefined,
        systemPromptRatio: fileContextBudget.system_prompt_ratio != null ? num(fileContextBudget.system_prompt_ratio, 0.20) : undefined,
        briefingRatio: fileContextBudget.briefing_ratio != null ? num(fileContextBudget.briefing_ratio, 0.15) : undefined,
        recentHistoryRatio: fileContextBudget.recent_history_ratio != null ? num(fileContextBudget.recent_history_ratio, 0.50) : undefined,
        outputReserve: fileContextBudget.output_reserve != null ? num(fileContextBudget.output_reserve, 4096) : undefined,
        minRecentMessages: fileContextBudget.min_recent_messages != null ? num(fileContextBudget.min_recent_messages, 6) : undefined,
        maxBriefingTokens: fileContextBudget.max_briefing_tokens != null ? num(fileContextBudget.max_briefing_tokens, 3000) : undefined,
    } : undefined;

    const config: AppConfig = {
        llmProfiles,
        modelTiers,
        persona: {
            name: str(filePersona.name) ?? "赛博群友",
            description: str(filePersona.description) ?? "",
        },
        timezone: str(fileConfig.timezone),
        telegram: {
            mode: (str(fileTG.mode) as "bot" | "userbot") ?? "bot",
            botToken: str(fileTG.bot_token) ?? "",
            apiId: str(fileTG.api_id) ?? "",
            apiHash: str(fileTG.api_hash) ?? "",
            phone: str(fileTG.phone) ?? "",
        },
        notification: {
            mentionKeywords: Array.isArray(fileNotification.mention_keywords)
                ? (fileNotification.mention_keywords as string[])
                : [],
        },
        reflection: {
            temperature: fileReflection.temperature != null ? num(fileReflection.temperature, 0.3) : undefined,
            maxTokens: fileReflection.max_tokens != null ? num(fileReflection.max_tokens, 16384) : undefined,
            model: str(fileReflection.model),
            silenceThreshold: fileReflection.silence_threshold != null ? num(fileReflection.silence_threshold, 7200) : undefined,
            maxInterval: fileReflection.max_interval != null ? num(fileReflection.max_interval, 86400) : undefined,
            checkInterval: fileReflection.check_interval != null ? num(fileReflection.check_interval, 300) : undefined,
            mergeThresholds: Object.keys(fileMerge).length > 0 ? {
                episodeToWeek: fileMerge.episode_to_week != null ? num(fileMerge.episode_to_week, 7) : undefined,
                weekToMonth: fileMerge.week_to_month != null ? num(fileMerge.week_to_month, 30) : undefined,
                monthToQuarter: fileMerge.month_to_quarter != null ? num(fileMerge.month_to_quarter, 90) : undefined,
                quarterToYear: fileMerge.quarter_to_year != null ? num(fileMerge.quarter_to_year, 365) : undefined,
            } : undefined,
            tierLimits: Object.keys(parsedTierLimits).length > 0 ? parsedTierLimits : undefined,
            awakeHours: Array.isArray(fileReflection.awake_hours) && (fileReflection.awake_hours as number[]).length === 2
                ? fileReflection.awake_hours as [number, number] : undefined,
        },
        contextBudget: parsedContextBudget,
        embedding: parseEmbeddingConfig(fileConfig),
        subagent: parseSubagentConfig(fileConfig),
        dashboard: parseDashboardConfig(fileConfig),
        vision: parseVisionConfig(fileConfig),
    };

    _cached = config;
    return config;
}

/** 根据 profile 名称获取 LLMConfig */
export function resolveLLMProfile(profileName: string, config?: AppConfig): LLMConfig {
    const cfg = config ?? loadConfig();
    const profile = cfg.llmProfiles[profileName];
    if (!profile) {
        const fallback = Object.keys(cfg.llmProfiles)[0];
        console.warn(`[Config] LLM profile "${profileName}" not found, using "${fallback}"`);
        return cfg.llmProfiles[fallback] ?? DEFAULT_LLM;
    }
    return profile;
}

/** 根据 tier 名称获取 LLMConfig */
export function resolveTierProfile(tier: string, config?: AppConfig): LLMConfig {
    const cfg = config ?? loadConfig();
    const profileName = cfg.modelTiers[tier];
    if (!profileName) {
        const fallback = Object.keys(cfg.llmProfiles)[0];
        console.warn(`[Config] tier "${tier}" not configured, using profile "${fallback}"`);
        return cfg.llmProfiles[fallback] ?? DEFAULT_LLM;
    }
    return resolveLLMProfile(profileName, cfg);
}

/** 获取 embedding 配置 */
export function resolveEmbeddingConfig(config?: AppConfig): EmbeddingConfig {
    const cfg = config ?? loadConfig();
    return cfg.embedding;
}

export function clearConfigCache(): void {
    _cached = null;
}

// ─── Embedding 配置解析 ───

function parseEmbeddingConfig(fileConfig: Record<string, unknown>): EmbeddingConfig {
    const raw = (fileConfig.embedding ?? {}) as Record<string, unknown>;

    const result: EmbeddingConfig = {
        provider: (str(raw.provider) as "openai" | "local") ?? DEFAULT_EMBEDDING.provider,
        baseUrl: str(raw.base_url) ?? DEFAULT_EMBEDDING.baseUrl,
        apiKey: str(raw.api_key) ?? DEFAULT_EMBEDDING.apiKey,
        model: str(raw.model) ?? DEFAULT_EMBEDDING.model,
        dimensions: raw.dimensions != null ? num(raw.dimensions, DEFAULT_EMBEDDING.dimensions) : DEFAULT_EMBEDDING.dimensions,
        similarityMetric: (str(raw.similarity_metric) as SimilarityMetric) ?? DEFAULT_EMBEDDING.similarityMetric,
    };

    // provider=openai 且 dimensions 未显式配置 → 用 1536（OpenAI 默认）
    if (result.provider === "openai" && raw.dimensions == null) {
        result.dimensions = 1536;
    }

    return result;
}

// ─── Dashboard 配置解析 ───

function parseDashboardConfig(fileConfig: Record<string, unknown>): DashboardExternalConfig | undefined {
    const raw = fileConfig.dashboard as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object") return undefined;
    return {
        enabled: raw.enabled != null ? Boolean(raw.enabled) : undefined,
        port: raw.port != null ? num(raw.port, 6767) : undefined,
        token: str(raw.token),
    };
}

// ─── Subagent 配置解析 ───

function parseSubagentConfig(fileConfig: Record<string, unknown>): SubagentExternalConfig | undefined {
    const raw = fileConfig.subagent as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object") return undefined;

    const rawFP = (raw.fast_path ?? {}) as Record<string, unknown>;
    const rawStick = (raw.stickiness ?? {}) as Record<string, unknown>;
    const rawStickT = (raw.stickiness_thresholds ?? {}) as Record<string, unknown>;
    const rawUpgrade = (rawStickT.upgrade ?? {}) as Record<string, unknown>;
    const rawDowngrade = (rawStickT.downgrade ?? {}) as Record<string, unknown>;
    const rawAQ = (raw.attention_queue ?? {}) as Record<string, unknown>;
    const rawObs = (raw.observer ?? {}) as Record<string, unknown>;
    const rawML = (raw.main_loop ?? {}) as Record<string, unknown>;
    const rawDec = (raw.decision ?? {}) as Record<string, unknown>;
    const rawGS = (raw.global_state ?? {}) as Record<string, unknown>;
    const rawCA = (raw.code_act ?? {}) as Record<string, unknown>;
    const rawCD = (raw.cosine_decay ?? {}) as Record<string, unknown>;

    // Parse stickiness levels
    const stickinessDefaults: SubagentExternalConfig["stickiness"] = {};
    for (const level of ["CORE", "FAMILIAR", "ACQUAINTANCE", "STRANGER"]) {
        const lv = rawStick[level] as Record<string, unknown> | undefined;
        if (lv && typeof lv === "object") {
            stickinessDefaults[level] = {
                priorityMultiplier: lv.priority_multiplier != null ? num(lv.priority_multiplier, 1) : undefined,
                depthCyclePeriod: lv.depth_cycle_period != null ? num(lv.depth_cycle_period, 20) : undefined,
            };
        }
    }

    return {
        maxSandboxInstances: raw.max_sandbox_instances != null ? num(raw.max_sandbox_instances, 5) : undefined,
        sandboxIdleTimeout: raw.sandbox_idle_timeout != null ? num(raw.sandbox_idle_timeout, 600000) : undefined,
        pollInterval: raw.poll_interval != null ? num(raw.poll_interval, 5000) : undefined,
        alertEngagementThreshold: raw.alert_engagement_threshold != null ? num(raw.alert_engagement_threshold, 60) : undefined,
        cosineDecay: Object.keys(rawCD).length > 0 ? {
            defaultCyclePeriod: rawCD.default_cycle_period != null ? num(rawCD.default_cycle_period, 20) : undefined,
        } : undefined,
        fastPath: Object.keys(rawFP).length > 0 ? {
            defaultMaxReplies: rawFP.default_max_replies != null ? num(rawFP.default_max_replies, 3) : undefined,
            defaultExpiresMinutes: rawFP.default_expires_minutes != null ? num(rawFP.default_expires_minutes, 5) : undefined,
            engagementThreshold: rawFP.engagement_threshold != null ? num(rawFP.engagement_threshold, 70) : undefined,
        } : undefined,
        stickiness: Object.keys(stickinessDefaults).length > 0 ? stickinessDefaults : undefined,
        stickinessThresholds: Object.keys(rawStickT).length > 0 ? {
            upgrade: Object.keys(rawUpgrade).length > 0 ? {
                strangerToAcquaintance: rawUpgrade.stranger_to_acquaintance != null ? num(rawUpgrade.stranger_to_acquaintance, 5) : undefined,
                acquaintanceToFamiliar: rawUpgrade.acquaintance_to_familiar != null ? num(rawUpgrade.acquaintance_to_familiar, 20) : undefined,
                familiarToCore: rawUpgrade.familiar_to_core != null ? num(rawUpgrade.familiar_to_core, 50) : undefined,
            } : undefined,
            downgrade: Object.keys(rawDowngrade).length > 0 ? {
                coreToFamiliar: rawDowngrade.core_to_familiar != null ? num(rawDowngrade.core_to_familiar, 14) : undefined,
                familiarToAcquaintance: rawDowngrade.familiar_to_acquaintance != null ? num(rawDowngrade.familiar_to_acquaintance, 30) : undefined,
                acquaintanceToStranger: rawDowngrade.acquaintance_to_stranger != null ? num(rawDowngrade.acquaintance_to_stranger, 60) : undefined,
            } : undefined,
        } : undefined,
        attentionQueue: Object.keys(rawAQ).length > 0 ? {
            timeDecayPerSecond: rawAQ.time_decay_per_second != null ? num(rawAQ.time_decay_per_second, 0.001) : undefined,
            maxSize: rawAQ.max_size != null ? num(rawAQ.max_size, 100) : undefined,
        } : undefined,
        observer: Object.keys(rawObs).length > 0 ? {
            engagementWindowMs: rawObs.engagement_window_ms != null ? num(rawObs.engagement_window_ms, 300000) : undefined,
        } : undefined,
        mainLoop: Object.keys(rawML).length > 0 ? {
            maxAttendsPerTick: rawML.max_attends_per_tick != null ? num(rawML.max_attends_per_tick, 3) : undefined,
        } : undefined,
        decision: Object.keys(rawDec).length > 0 ? {
            batchThreshold: rawDec.batch_threshold != null ? num(rawDec.batch_threshold, 50) : undefined,
            noneThreshold: rawDec.none_threshold != null ? num(rawDec.none_threshold, 10) : undefined,
            batchMessageThreshold: rawDec.batch_message_threshold != null ? num(rawDec.batch_message_threshold, 10) : undefined,
        } : undefined,
        globalState: Object.keys(rawGS).length > 0 ? {
            maxRecentDecisions: rawGS.max_recent_decisions != null ? num(rawGS.max_recent_decisions, 50) : undefined,
            autoSaveInterval: rawGS.auto_save_interval != null ? num(rawGS.auto_save_interval, 30000) : undefined,
        } : undefined,
        codeAct: Object.keys(rawCA).length > 0 ? {
            maxExecutionTimeMs: rawCA.max_execution_time_ms != null ? num(rawCA.max_execution_time_ms, 60000) : undefined,
            maxSessionMessages: rawCA.max_session_messages != null ? num(rawCA.max_session_messages, 100) : undefined,
        } : undefined,
    };
}

// ─── Vision 配置解析 ───

function parseVisionConfig(fileConfig: Record<string, unknown>): VisionConfig | undefined {
    const raw = fileConfig.vision as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object") return undefined;
    return {
        maxImageSize: raw.max_image_size != null ? num(raw.max_image_size, 1024) : undefined,
        maxImagesPerContext: raw.max_images_per_context != null ? num(raw.max_images_per_context, 3) : undefined,
        stickerMode: (str(raw.sticker_mode) as VisionConfig["stickerMode"]) ?? undefined,
    };
}

// ─── 内部辅助 ───

function parseLLMProfile(raw: Record<string, unknown>): LLMConfig {
    return {
        provider: (str(raw.provider) as "anthropic" | "openai") ?? DEFAULT_LLM.provider,
        baseUrl: str(raw.base_url) ?? DEFAULT_LLM.baseUrl,
        apiKey: str(raw.api_key) ?? DEFAULT_LLM.apiKey,
        model: str(raw.model) ?? DEFAULT_LLM.model,
        temperature: num(raw.temperature, DEFAULT_LLM.temperature),
        maxTokens: num(raw.max_tokens, DEFAULT_LLM.maxTokens),
        thinkingLevel: str(raw.thinking_level),
        vision: raw.vision === true ? true : undefined,
    };
}

function str(val: unknown): string | undefined {
    if (val === undefined || val === null || val === "") return undefined;
    return String(val);
}

function num(val: unknown, fallback: number): number {
    if (val === undefined || val === null) return fallback;
    const n = Number(val);
    return isNaN(n) ? fallback : n;
}
