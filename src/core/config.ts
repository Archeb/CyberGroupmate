/**
 * config.ts — 统一配置管理器
 *
 * 从 config.yaml 加载配置。
 *
 * LLM 配置使用 Profile 体系：
 *   llm_profiles: 定义多个命名 LLM 配置
 *   llm_routing: 按组件路由到指定 profile
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { parse as parseYAML, stringify as stringifyYAML } from "yaml";
import { clearAllPools } from "./llm-pool.js";

// ─── 类型定义 ───

/** Pool 调度策略 */
export type PoolStrategy = "round_robin" | "least_pending" | "random";

/** Pool 成员配置（YAML 中 pool.keys 的每一项） */
export interface PoolMemberConfig {
    apiKey: string;
    /** 可选，不同 key 可使用不同 base_url（如 AI Studio vs Vertex AI） */
    baseUrl?: string;
    /** 权重，默认 1 */
    weight?: number;
}

/** Pool 配置 */
export interface PoolConfig {
    strategy: PoolStrategy;
    members: PoolMemberConfig[];
}

export interface LLMConfig {
    provider: "anthropic" | "openai" | "google";
    baseUrl: string;
    apiKey: string;
    model: string;
    temperature: number;
    maxTokens: number;
    /** 模型允许的最大上下文输入 token 数。用于触发 compact。未设置则使用 context_budget.effective_context_window（默认 32000） */
    maxContextTokens?: number;
    /** Gemini thinking level: "none" | "low" | "medium" | "high" */
    thinkingLevel?: string;
    /** 此 profile 是否支持多模态图片输入。默认 false */
    vision?: boolean;
    /** 此 profile 是否支持 assistant prefill（预填充）。默认 true（anthropic/大多数 openai 兼容 API 均支持） */
    supportsPrefill?: boolean;
    /** Token 价格（每百万 token，USD），可选 */
    pricing?: {
        /** 输入 token 单价 */
        input: number;
        /** 输出 token 单价 */
        output: number;
        /** 缓存命中输入单价 */
        cachedInput?: number;
        /** Anthropic 缓存创建单价 */
        cacheCreation?: number;
    };
    /** 多 key 负载均衡池。设置后 apiKey 字段将被忽略，由 pool 调度器选择实际 key */
    pool?: PoolConfig;
    /** Vertex AI 项目 ID（设置后启用 Vertex AI 模式，仅 provider=google 时生效） */
    vertexProject?: string;
    /** Vertex AI 区域（默认 us-central1，仅 provider=google 时生效） */
    vertexRegion?: string;
    /** Vertex AI 服务账号 JSON 密钥（原文保存在 config.yaml，仅 provider=google 时生效） */
    vertexCredentials?: Record<string, unknown>;
    /** 额外请求体字段。JSON 对象，会被直接展开合并到 API 请求体中（仅 openai/anthropic provider） */
    extraBody?: Record<string, unknown>;
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

/** 组件路由中可配置超时的组件名 */
export type RoutingComponentKey = 'attend' | 'session' | 'fast_path' | 'recording_cluster' | 'recording_triage' | 'reflection' | 'compact' | 'memory' | 'vision';

/** 组件级 LLM 路由 — 每个组件可指定一个或多个 profile（fallback chain） */
export interface LLMRoutingConfig {
    /** 注意力决策（attend-handler） */
    attend?: string | string[];
    /** CodeAct 多轮交互（session-runner） */
    session?: string | string[];
    /** 快速回复（fast-path-handler） */
    fast_path?: string | string[];
    /** 话题聚类（recording-pipeline Step 1） */
    recording_cluster?: string | string[];
    /** 话题摘要 + Triage（recording-pipeline Step 2） */
    recording_triage?: string | string[];
    /** 反思引擎（reflection） */
    reflection?: string | string[];
    /** 上下文压缩（context-manager compact） */
    compact?: string | string[];
    /** Deep recall / browse（memory-v2） */
    memory?: string | string[];
    /** Vision 描述（vision-processor，独立配置） */
    vision?: string | string[];
    /** 每组件 LLM 请求超时（毫秒）。未设置的组件使用默认 60000 */
    /** @deprecated 兼容旧配置：recording 会被同时应用到 recording_cluster 和 recording_triage */
    recording?: string | string[];
    /** 每组件 LLM 请求超时（毫秒）。未设置的组件使用默认 60000 */
    timeouts?: Partial<Record<RoutingComponentKey | 'recording', number>>;
}

export interface PersonaConfig {
    name: string;
    description: string;
}

export interface NotificationConfig {
    /** 触发 Q3 即时入队 + Observer 提权的关键词（agent 名字等） */
    mentionKeywords: string[];
}

/** Telegram 入站白名单：仅当 enabled 为 true 时按群组 / 私聊 ID 过滤 */
export interface TelegramWhitelistConfig {
    /** 是否启用白名单。false 时不拒绝任何聊天 */
    enabled: boolean;
    /** 允许的群组/超级群/频道 chat ID（纯数字字符串，如 "-1001234567890"） */
    groups: string[];
    /** 允许的私聊对方用户 ID（纯数字字符串） */
    users: string[];
}

export interface TelegramConfig {
    mode: "bot" | "userbot";
    botToken: string;
    apiId: string;
    apiHash: string;
    phone: string;
    /** 入站白名单（可选） */
    whitelist?: TelegramWhitelistConfig;
    /** 拟人化发送延迟配置 */
    humanizedDelay?: {
        /** 是否启用 */
        enabled: boolean;
        /** 每个字符的延迟毫秒数（打字速度），默认 50 */
        msPerChar: number;
        /** 最小延迟 ms，默认 500 */
        minDelay: number;
        /** 最大延迟 ms，默认 5000 */
        maxDelay: number;
    };
}

export interface DiscordConfig {
    botToken: string;
    applicationId?: string;
}

export interface ReflectionExternalConfig {
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
        maxTurns?: number;
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
    /** 媒体下载文件大小上限 (MB)。默认 20 */
    maxMediaDownloadSize?: number;
    /** 媒体文件保留天数。默认 3 */
    mediaRetentionDays?: number;
}

/** Recording Pipeline 缓冲/触发配置 */
export interface RecordingPipelineConfig {
    /** 缓冲区最少消息数才触发 flush（静默到期时检查）。默认 10 */
    minFlushSize?: number;
    /** 正常缓冲阈值（条数）。默认 50 */
    normalThreshold?: number;
    /** 加速缓冲阈值（条数）。默认 15 */
    eagerThreshold?: number;
    /** 正常静默触发时间（毫秒）。默认 120000 (2 min) */
    normalSilenceMs?: number;
    /** 加速静默触发时间（毫秒）。默认 30000 (30 sec) */
    eagerSilenceMs?: number;
}

/** Dashboard 外部配置 */
export interface DashboardExternalConfig {
    /** 是否启用。默认 true */
    enabled?: boolean;
    /**
     * HTTP 监听地址。默认 "127.0.0.1"（仅本机）。
     * 若需公网访问可设为 "0.0.0.0"，此时必须设置非空 token（见 config 注释）。
     */
    host?: string;
    /** HTTP 端口。默认 6767 */
    port?: number;
    /** 认证 Token */
    token?: string;
}

/** Metrics Exporter 配置 */
export interface MetricsConfig {
    /** 是否启用。默认 true */
    enabled?: boolean;
    /**
     * 绑定地址。默认且强烈推荐保持 "127.0.0.1"（仅本机可访问）。
     * 若需要远端 Prometheus 抓取，请使用反向代理并加 IP allowlist，
     * 不要直接改为 0.0.0.0，除非你清楚了解安全风险。
     */
    host?: string;
    /** HTTP 监听端口。默认 9091 */
    port?: number;
    /** scrape 路径。默认 "/metrics" */
    path?: string;
}

/** Token 价格配置（每百万 token，USD） */
export type TokenPricingEntry = NonNullable<LLMConfig["pricing"]>;

/** 环境变量配置项 */
export interface EnvironmentVariable {
    /** 环境变量名称 */
    key: string;
    /** 环境变量值 */
    value: string;
    /** 作用域：both=主进程+沙盒, host=仅主进程, sandbox=仅沙盒 */
    scope: "both" | "host" | "sandbox";
}

export interface AppConfig {
    llmProfiles: Record<string, LLMConfig>;
    llmRouting: LLMRoutingConfig;
    persona: PersonaConfig;
    /** Agent 所处时区 (IANA 标识符，如 "Asia/Shanghai")。影响 LLM prompt 中的时间展示和作息判断。 */
    timezone?: string;
    telegram?: TelegramConfig;
    discord?: DiscordConfig;
    notification: NotificationConfig;
    reflection: ReflectionExternalConfig;
    contextBudget?: ContextBudgetConfig;
    embedding: EmbeddingConfig;
    subagent?: SubagentExternalConfig;
    dashboard?: DashboardExternalConfig;
    vision?: VisionConfig;
    /** Recording Pipeline 缓冲/触发配置 */
    recordingPipeline?: RecordingPipelineConfig;
    /** 自定义环境变量（通过 Dashboard 管理） */
    envVars?: EnvironmentVariable[];
    /** Prometheus Metrics Exporter 配置 */
    metrics?: MetricsConfig;
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

    // ─── LLM Routing（组件级路由） ───
    const fileRouting = (fileConfig.llm_routing ?? {}) as Record<string, unknown>;
    // 解析 per-component timeouts
    const rawTimeouts = (fileRouting.timeouts ?? {}) as Record<string, unknown>;
    const parsedTimeouts: LLMRoutingConfig['timeouts'] = {};
    for (const key of ['attend', 'session', 'fast_path', 'recording_cluster', 'recording_triage', 'recording', 'reflection', 'compact', 'memory', 'vision'] as const) {
        if (rawTimeouts[key] != null) {
            parsedTimeouts[key] = num(rawTimeouts[key], 60000);
        }
    }

    // 兼容旧配置：如果只配了 recording，同时应用到 cluster 和 triage
    const recordingFallback = parseRoutingValue(fileRouting.recording);
    const llmRouting: LLMRoutingConfig = {
        attend: parseRoutingValue(fileRouting.attend),
        session: parseRoutingValue(fileRouting.session),
        fast_path: parseRoutingValue(fileRouting.fast_path),
        recording_cluster: parseRoutingValue(fileRouting.recording_cluster) ?? recordingFallback,
        recording_triage: parseRoutingValue(fileRouting.recording_triage) ?? recordingFallback,
        reflection: parseRoutingValue(fileRouting.reflection),
        compact: parseRoutingValue(fileRouting.compact),
        memory: parseRoutingValue(fileRouting.memory),
        vision: parseRoutingValue(fileRouting.vision),
        timeouts: Object.keys(parsedTimeouts).length > 0 ? parsedTimeouts : undefined,
    };

    // ─── 其他配置 ───
    const filePersona = (fileConfig.persona ?? {}) as Record<string, unknown>;
    const fileTG = (fileConfig.telegram ?? {}) as Record<string, unknown>;
    const fileDC = (fileConfig.discord ?? {}) as Record<string, unknown>;
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
        llmRouting,
        persona: {
            name: str(filePersona.name) ?? "赛博群友",
            description: str(filePersona.description) ?? "",
        },
        timezone: str(fileConfig.timezone),
        telegram: Object.keys(fileTG).length > 0 ? {
            mode: (str(fileTG.mode) as "bot" | "userbot") ?? "bot",
            botToken: str(fileTG.bot_token) ?? "",
            apiId: str(fileTG.api_id) ?? "",
            apiHash: str(fileTG.api_hash) ?? "",
            phone: str(fileTG.phone) ?? "",
            whitelist: parseTelegramWhitelist(fileTG),
            humanizedDelay: parseHumanizedDelay(fileTG),
        } : undefined,
        discord: Object.keys(fileDC).length > 0 ? {
            botToken: str(fileDC.bot_token) ?? "",
            applicationId: str(fileDC.application_id),
        } : undefined,
        notification: {
            mentionKeywords: Array.isArray(fileNotification.mention_keywords)
                ? (fileNotification.mention_keywords as string[])
                : [],
        },
        reflection: {
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
        recordingPipeline: parseRecordingPipelineConfig(fileConfig),
        envVars: parseEnvVars(fileConfig),
        metrics: parseMetricsConfig(fileConfig),
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

/**
 * 根据组件名获取所有 fallback LLMConfig（按优先级排序）。
 * 查找顺序：llm_routing[component] → 第一个 llmProfile（兜底）
 * 当 llm_routing 中配置为数组时，返回多个 profile 供 callLLMWithFallback 使用。
 */
export function resolveComponentProfiles(component: RoutingComponentKey, config?: AppConfig): LLMConfig[] {
    const cfg = config ?? loadConfig();
    const routingValue = cfg.llmRouting[component];
    if (!routingValue) {
        // 未配置路由：fallback 到第一个 profile
        const fallback = Object.keys(cfg.llmProfiles)[0];
        console.warn(`[Config] llm_routing.${component} not configured, using profile "${fallback}"`);
        return [cfg.llmProfiles[fallback] ?? DEFAULT_LLM];
    }
    const names = Array.isArray(routingValue) ? routingValue : [routingValue];
    return names.map(n => resolveLLMProfile(n, cfg));
}

/**
 * 获取组件的 LLM 请求超时（毫秒）。
 * 优先返回 llmRouting.timeouts[component]，未设置则返回 undefined（由调用方使用默认值）。
 */
export function resolveComponentTimeout(component: RoutingComponentKey, config?: AppConfig): number | undefined {
    const cfg = config ?? loadConfig();
    const direct = cfg.llmRouting.timeouts?.[component];
    if (direct != null) return direct;
    // 兼容旧配置：recording_cluster / recording_triage 可 fallback 到 recording
    if (component === 'recording_cluster' || component === 'recording_triage') {
        return cfg.llmRouting.timeouts?.['recording' as keyof typeof cfg.llmRouting.timeouts];
    }
    return undefined;
}

/** 获取 embedding 配置 */
export function resolveEmbeddingConfig(config?: AppConfig): EmbeddingConfig {
    const cfg = config ?? loadConfig();
    return cfg.embedding;
}

export function clearConfigCache(): void {
    _cached = null;
    // Pool 实例与配置绑定，配置变更时需同步清理以保证新 pool 生效
    clearAllPools();
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
        host: str(raw.host),
        port: raw.port != null ? num(raw.port, 6767) : undefined,
        token: str(raw.token),
    };
}

// ─── Metrics 配置解析 ───

function parseMetricsConfig(fileConfig: Record<string, unknown>): MetricsConfig | undefined {
    const raw = fileConfig.metrics as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object") return undefined;
    return {
        enabled: raw.enabled != null ? Boolean(raw.enabled) : undefined,
        host: str(raw.host),
        port: raw.port != null ? num(raw.port, 9091) : undefined,
        path: str(raw.path),
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
            maxTurns: rawCA.max_turns != null ? num(rawCA.max_turns, 30) : undefined,
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
        maxMediaDownloadSize: raw.max_media_download_size != null ? num(raw.max_media_download_size, 20) : undefined,
        mediaRetentionDays: raw.media_retention_days != null ? num(raw.media_retention_days, 3) : undefined,
    };
}

// ─── Recording Pipeline 配置解析 ───

function parseRecordingPipelineConfig(fileConfig: Record<string, unknown>): RecordingPipelineConfig | undefined {
    const raw = fileConfig.recording_pipeline as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object") return undefined;
    return {
        minFlushSize: raw.min_flush_size != null ? num(raw.min_flush_size, 10) : undefined,
        normalThreshold: raw.normal_threshold != null ? num(raw.normal_threshold, 50) : undefined,
        eagerThreshold: raw.eager_threshold != null ? num(raw.eager_threshold, 15) : undefined,
        normalSilenceMs: raw.normal_silence_ms != null ? num(raw.normal_silence_ms, 120000) : undefined,
        eagerSilenceMs: raw.eager_silence_ms != null ? num(raw.eager_silence_ms, 30000) : undefined,
    };
}

// ─── 环境变量配置解析 ───

function parseEnvVars(fileConfig: Record<string, unknown>): EnvironmentVariable[] | undefined {
    const raw = fileConfig.env_vars as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    const VALID_SCOPES = new Set(["both", "host", "sandbox"]);
    const result: EnvironmentVariable[] = [];
    for (const item of raw) {
        const key = str(item.key);
        const value = str(item.value);
        const scope = str(item.scope) ?? "both";
        if (!key) continue; // key 是必需的
        if (!VALID_SCOPES.has(scope)) continue;
        result.push({ key, value: value ?? "", scope: scope as EnvironmentVariable["scope"] });
    }
    return result.length > 0 ? result : undefined;
}

// ─── 内部辅助 ───

function parseLLMProfile(raw: Record<string, unknown>): LLMConfig {
    const rawPricing = raw.pricing as Record<string, unknown> | undefined;
    let pricing: LLMConfig["pricing"] = undefined;
    if (rawPricing && typeof rawPricing === "object" && rawPricing.input != null && rawPricing.output != null) {
        pricing = {
            input: num(rawPricing.input, 0),
            output: num(rawPricing.output, 0),
            cachedInput: rawPricing.cached_input != null ? num(rawPricing.cached_input, 0) : undefined,
            cacheCreation: rawPricing.cache_creation != null ? num(rawPricing.cache_creation, 0) : undefined,
        };
    }

    // 解析 pool 配置
    let pool: PoolConfig | undefined = undefined;
    const rawPool = raw.pool as Record<string, unknown> | undefined;
    if (rawPool && typeof rawPool === "object") {
        const rawKeys = rawPool.keys as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(rawKeys) && rawKeys.length > 0) {
            const members: PoolMemberConfig[] = rawKeys.map(k => ({
                apiKey: str(k.api_key) ?? "",
                baseUrl: str(k.base_url),
                weight: k.weight != null ? num(k.weight, 1) : undefined,
            })).filter(m => m.apiKey.length > 0);
            if (members.length > 0) {
                const VALID_STRATEGIES = new Set(["round_robin", "least_pending", "random"]);
                const rawStrategy = str(rawPool.strategy) ?? "round_robin";
                const strategy = VALID_STRATEGIES.has(rawStrategy)
                    ? rawStrategy as PoolStrategy
                    : (() => {
                        console.warn(`[Config] pool.strategy "${rawStrategy}" 无效，使用 round_robin`);
                        return "round_robin" as PoolStrategy;
                    })();
                pool = {
                    strategy,
                    members,
                };
            }
        }
    }

    // 解析 vertex_credentials（JSON 对象，直接保存在 config.yaml 原文中）
    let vertexCredentials: Record<string, unknown> | undefined;
    if (raw.vertex_credentials && typeof raw.vertex_credentials === "object") {
        vertexCredentials = raw.vertex_credentials as Record<string, unknown>;
    }

    return {
        provider: (str(raw.provider) as "anthropic" | "openai" | "google") ?? DEFAULT_LLM.provider,
        baseUrl: str(raw.base_url) ?? DEFAULT_LLM.baseUrl,
        apiKey: str(raw.api_key) ?? DEFAULT_LLM.apiKey,
        model: str(raw.model) ?? DEFAULT_LLM.model,
        temperature: num(raw.temperature, DEFAULT_LLM.temperature),
        maxTokens: num(raw.max_tokens, DEFAULT_LLM.maxTokens),
        maxContextTokens: raw.max_context_tokens != null ? num(raw.max_context_tokens, 0) : undefined,
        thinkingLevel: str(raw.thinking_level),
        vision: raw.vision === true ? true : undefined,
        supportsPrefill: raw.supports_prefill === false ? false : undefined,
        pricing,
        pool,
        vertexProject: str(raw.vertex_project),
        vertexRegion: str(raw.vertex_region),
        vertexCredentials,
        extraBody: (raw.extra_body && typeof raw.extra_body === "object" && !Array.isArray(raw.extra_body))
            ? raw.extra_body as Record<string, unknown>
            : undefined,
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

/** 解析 routing 值：支持字符串或字符串数组，未配置返回 undefined */
function parseRoutingValue(val: unknown): string | string[] | undefined {
    if (val === undefined || val === null) return undefined;
    if (Array.isArray(val)) return val.map(String);
    return str(val);
}

/** 解析 humanized_delay 配置 */
function parseHumanizedDelay(fileTG: Record<string, unknown>): TelegramConfig["humanizedDelay"] {
    const raw = fileTG.humanized_delay as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object") return undefined;
    return {
        enabled: raw.enabled !== false,
        msPerChar: raw.ms_per_char != null ? num(raw.ms_per_char, 50) : 50,
        minDelay: raw.min_delay != null ? num(raw.min_delay, 500) : 500,
        maxDelay: raw.max_delay != null ? num(raw.max_delay, 5000) : 5000,
    };
}

function parseTelegramWhitelist(fileTG: Record<string, unknown>): TelegramWhitelistConfig | undefined {
    const raw = fileTG.whitelist as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object") return undefined;
    const groups = Array.isArray(raw.groups)
        ? (raw.groups as unknown[]).map(x => String(x).trim()).filter(Boolean)
        : [];
    const users = Array.isArray(raw.users)
        ? (raw.users as unknown[]).map(x => String(x).trim()).filter(Boolean)
        : [];
    return {
        enabled: raw.enabled === true,
        groups,
        users,
    };
}

// ─── 序列化 + 验证（Dashboard Config Editor 用） ───

/** 将 AppConfig 序列化为 YAML 格式的对象（snake_case keys） */
export function serializeConfigToObject(config: AppConfig): Record<string, unknown> {
    const obj: Record<string, unknown> = {};

    // llm_profiles
    const profiles: Record<string, unknown> = {};
    for (const [name, p] of Object.entries(config.llmProfiles)) {
        const entry: Record<string, unknown> = {
            provider: p.provider,
            base_url: p.baseUrl,
            api_key: p.apiKey,
            model: p.model,
            temperature: p.temperature,
            max_tokens: p.maxTokens,
        };
        if (p.maxContextTokens != null) entry.max_context_tokens = p.maxContextTokens;
        if (p.thinkingLevel != null) entry.thinking_level = p.thinkingLevel;
        if (p.vision === true) entry.vision = true;
        if (p.vertexProject) entry.vertex_project = p.vertexProject;
        if (p.vertexRegion) entry.vertex_region = p.vertexRegion;
        if (p.vertexCredentials) entry.vertex_credentials = p.vertexCredentials;
        if (p.extraBody && Object.keys(p.extraBody).length > 0) entry.extra_body = p.extraBody;
        if (p.supportsPrefill === false) entry.supports_prefill = false;
        if (p.pricing) {
            const pricing: Record<string, unknown> = {
                input: p.pricing.input,
                output: p.pricing.output,
            };
            if (p.pricing.cachedInput != null) pricing.cached_input = p.pricing.cachedInput;
            if (p.pricing.cacheCreation != null) pricing.cache_creation = p.pricing.cacheCreation;
            entry.pricing = pricing;
        }
        if (p.pool) {
            entry.pool = {
                strategy: p.pool.strategy,
                keys: p.pool.members.map(m => {
                    const k: Record<string, unknown> = { api_key: m.apiKey };
                    if (m.baseUrl) k.base_url = m.baseUrl;
                    if (m.weight != null && m.weight !== 1) k.weight = m.weight;
                    return k;
                }),
            };
        }
        profiles[name] = entry;
    }
    obj.llm_profiles = profiles;

    // llm_routing
    const routing: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(config.llmRouting)) {
        if (key === 'timeouts') continue; // timeouts 单独处理
        if (val != null) routing[key] = val;
    }
    if (config.llmRouting.timeouts && Object.keys(config.llmRouting.timeouts).length > 0) {
        routing.timeouts = { ...config.llmRouting.timeouts };
    }
    obj.llm_routing = routing;

    // persona
    obj.persona = { name: config.persona.name, description: config.persona.description };

    // timezone
    if (config.timezone) obj.timezone = config.timezone;

    // notification
    obj.notification = { mention_keywords: config.notification.mentionKeywords };

    // telegram
    if (config.telegram) {
        const tg: Record<string, unknown> = {
            mode: config.telegram.mode,
            bot_token: config.telegram.botToken,
            api_id: config.telegram.apiId,
            api_hash: config.telegram.apiHash,
            phone: config.telegram.phone,
        };
        if (config.telegram.humanizedDelay) {
            tg.humanized_delay = {
                enabled: config.telegram.humanizedDelay.enabled,
                ms_per_char: config.telegram.humanizedDelay.msPerChar,
                min_delay: config.telegram.humanizedDelay.minDelay,
                max_delay: config.telegram.humanizedDelay.maxDelay,
            };
        }
        if (config.telegram.whitelist) {
            tg.whitelist = {
                enabled: config.telegram.whitelist.enabled,
                groups: config.telegram.whitelist.groups,
                users: config.telegram.whitelist.users,
            };
        }
        obj.telegram = tg;
    }

    // discord
    if (config.discord) {
        const dc: Record<string, unknown> = {
            bot_token: config.discord.botToken,
        };
        if (config.discord.applicationId) dc.application_id = config.discord.applicationId;
        obj.discord = dc;
    }

    // reflection
    const refl: Record<string, unknown> = {};
    const r = config.reflection;
    if (r.silenceThreshold != null) refl.silence_threshold = r.silenceThreshold;
    if (r.maxInterval != null) refl.max_interval = r.maxInterval;
    if (r.checkInterval != null) refl.check_interval = r.checkInterval;
    if (r.mergeThresholds) {
        const mt: Record<string, unknown> = {};
        if (r.mergeThresholds.episodeToWeek != null) mt.episode_to_week = r.mergeThresholds.episodeToWeek;
        if (r.mergeThresholds.weekToMonth != null) mt.week_to_month = r.mergeThresholds.weekToMonth;
        if (r.mergeThresholds.monthToQuarter != null) mt.month_to_quarter = r.mergeThresholds.monthToQuarter;
        if (r.mergeThresholds.quarterToYear != null) mt.quarter_to_year = r.mergeThresholds.quarterToYear;
        refl.merge_thresholds = mt;
    }
    if (r.tierLimits) {
        const tl: Record<string, unknown> = {};
        for (const [tier, limits] of Object.entries(r.tierLimits)) {
            const entry: Record<string, unknown> = {};
            if (limits.maxTraits != null) entry.max_traits = limits.maxTraits;
            if (limits.maxInterests != null) entry.max_interests = limits.maxInterests;
            if (limits.episodeDays != null) entry.episode_days = limits.episodeDays;
            tl[tier] = entry;
        }
        refl.tier_limits = tl;
    }
    if (r.awakeHours) refl.awake_hours = r.awakeHours;
    obj.reflection = refl;

    // context_budget
    if (config.contextBudget) {
        const cb: Record<string, unknown> = {};
        const b = config.contextBudget;
        if (b.effectiveContextWindow != null) cb.effective_context_window = b.effectiveContextWindow;
        if (b.systemPromptRatio != null) cb.system_prompt_ratio = b.systemPromptRatio;
        if (b.briefingRatio != null) cb.briefing_ratio = b.briefingRatio;
        if (b.recentHistoryRatio != null) cb.recent_history_ratio = b.recentHistoryRatio;
        if (b.outputReserve != null) cb.output_reserve = b.outputReserve;
        if (b.minRecentMessages != null) cb.min_recent_messages = b.minRecentMessages;
        if (b.maxBriefingTokens != null) cb.max_briefing_tokens = b.maxBriefingTokens;
        obj.context_budget = cb;
    }

    // embedding
    const emb: Record<string, unknown> = {
        provider: config.embedding.provider,
        base_url: config.embedding.baseUrl,
        api_key: config.embedding.apiKey,
        model: config.embedding.model,
        dimensions: config.embedding.dimensions,
        similarity_metric: config.embedding.similarityMetric,
    };
    obj.embedding = emb;

    // vision
    if (config.vision) {
        const v: Record<string, unknown> = {};
        if (config.vision.maxImageSize != null) v.max_image_size = config.vision.maxImageSize;
        if (config.vision.maxImagesPerContext != null) v.max_images_per_context = config.vision.maxImagesPerContext;
        if (config.vision.stickerMode != null) v.sticker_mode = config.vision.stickerMode;
        if (config.vision.maxMediaDownloadSize != null) v.max_media_download_size = config.vision.maxMediaDownloadSize;
        if (config.vision.mediaRetentionDays != null) v.media_retention_days = config.vision.mediaRetentionDays;
        obj.vision = v;
    }

    // recording_pipeline
    if (config.recordingPipeline) {
        const rp: Record<string, unknown> = {};
        const p = config.recordingPipeline;
        if (p.minFlushSize != null) rp.min_flush_size = p.minFlushSize;
        if (p.normalThreshold != null) rp.normal_threshold = p.normalThreshold;
        if (p.eagerThreshold != null) rp.eager_threshold = p.eagerThreshold;
        if (p.normalSilenceMs != null) rp.normal_silence_ms = p.normalSilenceMs;
        if (p.eagerSilenceMs != null) rp.eager_silence_ms = p.eagerSilenceMs;
        obj.recording_pipeline = rp;
    }

    // dashboard
    if (config.dashboard) {
        const d: Record<string, unknown> = {};
        if (config.dashboard.enabled != null) d.enabled = config.dashboard.enabled;
        if (config.dashboard.host != null) d.host = config.dashboard.host;
        if (config.dashboard.port != null) d.port = config.dashboard.port;
        if (config.dashboard.token != null) d.token = config.dashboard.token;
        obj.dashboard = d;
    }

    // subagent
    if (config.subagent) {
        const s: Record<string, unknown> = {};
        const sa = config.subagent;
        if (sa.maxSandboxInstances != null) s.max_sandbox_instances = sa.maxSandboxInstances;
        if (sa.sandboxIdleTimeout != null) s.sandbox_idle_timeout = sa.sandboxIdleTimeout;
        if (sa.pollInterval != null) s.poll_interval = sa.pollInterval;
        if (sa.alertEngagementThreshold != null) s.alert_engagement_threshold = sa.alertEngagementThreshold;
        if (sa.cosineDecay) s.cosine_decay = { default_cycle_period: sa.cosineDecay.defaultCyclePeriod };
        if (sa.fastPath) {
            s.fast_path = {
                default_max_replies: sa.fastPath.defaultMaxReplies,
                default_expires_minutes: sa.fastPath.defaultExpiresMinutes,
                engagement_threshold: sa.fastPath.engagementThreshold,
            };
        }
        if (sa.stickiness) {
            const stick: Record<string, unknown> = {};
            for (const [level, cfg] of Object.entries(sa.stickiness)) {
                stick[level] = {
                    priority_multiplier: cfg.priorityMultiplier,
                    depth_cycle_period: cfg.depthCyclePeriod,
                };
            }
            s.stickiness = stick;
        }
        if (sa.stickinessThresholds) {
            const st: Record<string, unknown> = {};
            if (sa.stickinessThresholds.upgrade) {
                st.upgrade = {
                    stranger_to_acquaintance: sa.stickinessThresholds.upgrade.strangerToAcquaintance,
                    acquaintance_to_familiar: sa.stickinessThresholds.upgrade.acquaintanceToFamiliar,
                    familiar_to_core: sa.stickinessThresholds.upgrade.familiarToCore,
                };
            }
            if (sa.stickinessThresholds.downgrade) {
                st.downgrade = {
                    core_to_familiar: sa.stickinessThresholds.downgrade.coreToFamiliar,
                    familiar_to_acquaintance: sa.stickinessThresholds.downgrade.familiarToAcquaintance,
                    acquaintance_to_stranger: sa.stickinessThresholds.downgrade.acquaintanceToStranger,
                };
            }
            s.stickiness_thresholds = st;
        }
        if (sa.attentionQueue) {
            s.attention_queue = {
                time_decay_per_second: sa.attentionQueue.timeDecayPerSecond,
                max_size: sa.attentionQueue.maxSize,
            };
        }
        if (sa.observer) s.observer = { engagement_window_ms: sa.observer.engagementWindowMs };
        if (sa.mainLoop) s.main_loop = { max_attends_per_tick: sa.mainLoop.maxAttendsPerTick };
        if (sa.decision) {
            s.decision = {
                batch_threshold: sa.decision.batchThreshold,
                none_threshold: sa.decision.noneThreshold,
                batch_message_threshold: sa.decision.batchMessageThreshold,
            };
        }
        if (sa.globalState) {
            s.global_state = {
                max_recent_decisions: sa.globalState.maxRecentDecisions,
                auto_save_interval: sa.globalState.autoSaveInterval,
            };
        }
        if (sa.codeAct) {
            s.code_act = {
                max_execution_time_ms: sa.codeAct.maxExecutionTimeMs,
                max_session_messages: sa.codeAct.maxSessionMessages,
                max_turns: sa.codeAct.maxTurns,
            };
        }
        obj.subagent = s;
    }

    // env_vars
    if (config.envVars && config.envVars.length > 0) {
        obj.env_vars = config.envVars.map(ev => ({
            key: ev.key,
            value: ev.value,
            scope: ev.scope,
        }));
    }

    return obj;
}

/** 将 AppConfig 序列化为 YAML 字符串 */
export function serializeConfigToYAML(config: AppConfig): string {
    return stringifyYAML(serializeConfigToObject(config), { lineWidth: 120 });
}

/** 将 AppConfig 写入 config.yaml 并热重载 */
export function saveConfig(config: AppConfig, configPath?: string): { ok: boolean; error?: string } {
    try {
        const path = configPath ?? "config.yaml";
        const yaml = serializeConfigToYAML(config);
        writeFileSync(path, yaml, "utf-8");
        clearConfigCache();
        loadConfig(path, true);
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

/** 验证配置有效性 */
export function validateConfig(config: unknown): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!config || typeof config !== "object") {
        return { valid: false, errors: ["配置不能为空"] };
    }
    const c = config as Record<string, unknown>;

    // llmProfiles
    const profiles = c.llmProfiles as Record<string, unknown> | undefined;
    if (!profiles || typeof profiles !== "object" || Object.keys(profiles).length === 0) {
        errors.push("至少需要一个 LLM Profile");
    } else {
        for (const [name, raw] of Object.entries(profiles)) {
            const p = raw as Record<string, unknown>;
            if (!p.provider) errors.push(`Profile "${name}": provider 不能为空`);
            const isGoogle = p.provider === "google";
            const creds = p.vertexCredentials as Record<string, unknown> | undefined;
            const hasVertexProject = !!p.vertexProject || !!(creds?.project_id);
            // google provider 不需要 baseUrl（SDK 自动处理）
            if (!isGoogle && !p.baseUrl) errors.push(`Profile "${name}": baseUrl 不能为空`);
            // apiKey 在有 pool 或 google+vertexProject 时可选
            const pool = p.pool as PoolConfig | undefined;
            if (!p.apiKey && !pool && !(isGoogle && hasVertexProject)) errors.push(`Profile "${name}": apiKey 不能为空（除非配置了 pool 或 Vertex AI）`);
            if (!p.model) errors.push(`Profile "${name}": model 不能为空`);
            if (typeof p.temperature === "number" && (p.temperature < 0 || p.temperature > 2)) {
                errors.push(`Profile "${name}": temperature 应在 0-2 之间`);
            }
            if (typeof p.maxTokens === "number" && p.maxTokens <= 0) {
                errors.push(`Profile "${name}": maxTokens 应大于 0`);
            }
            if (pool && (!pool.members || pool.members.length === 0)) {
                errors.push(`Profile "${name}": pool.keys 不能为空`);
            }
        }
    }

    // llmRouting
    const routing = c.llmRouting as Record<string, unknown> | undefined;
    const profileNames = profiles ? new Set(Object.keys(profiles)) : new Set<string>();
    if (routing && typeof routing === "object") {
        for (const [comp, val] of Object.entries(routing)) {
            if (comp === 'timeouts' || val == null) continue;
            const names = Array.isArray(val) ? val : [val];
            for (const n of names) {
                if (typeof n === "string" && !profileNames.has(n)) {
                    errors.push(`Routing "${comp}" 引用了不存在的 profile: "${n}"`);
                }
            }
        }
    }

    // persona
    const persona = c.persona as Record<string, unknown> | undefined;
    if (!persona?.name) errors.push("persona.name 不能为空");

    // telegram (optional)
    const tg = c.telegram as Record<string, unknown> | undefined;
    if (tg) {
        if (!tg.mode || (tg.mode !== "bot" && tg.mode !== "userbot")) {
            errors.push("telegram.mode 必须是 \"bot\" 或 \"userbot\"");
        }
        const wl = tg.whitelist as Record<string, unknown> | undefined;
        if (wl && typeof wl === "object" && wl.enabled === true) {
            const g = Array.isArray(wl.groups) ? wl.groups.length : 0;
            const u = Array.isArray(wl.users) ? wl.users.length : 0;
            if (g === 0 && u === 0) {
                errors.push("telegram.whitelist.enabled 为 true 时，groups 与 users 至少填写一项");
            }
        }
    }

    // dashboard (optional)
    const dash = c.dashboard as Record<string, unknown> | undefined;
    if (dash && typeof dash === "object") {
        const host = (dash.host as string | undefined) ?? "127.0.0.1";
        const token = dash.token != null ? String(dash.token) : "";
        if ((host === "0.0.0.0" || host === "::") && !token.trim()) {
            errors.push("dashboard.host 为 0.0.0.0 或 :: 时 token 不能为空");
        }
    }

    // discord (optional)
    const dc = c.discord as Record<string, unknown> | undefined;
    if (dc) {
        if (!dc.botToken) errors.push("discord.botToken 不能为空");
    }

    // contextBudget
    const cb = c.contextBudget as Record<string, unknown> | undefined;
    if (cb) {
        const ratioFields = ["systemPromptRatio", "briefingRatio", "recentHistoryRatio"];
        for (const field of ratioFields) {
            if (typeof cb[field] === "number" && (cb[field] as number < 0 || cb[field] as number > 1)) {
                errors.push(`contextBudget.${field} 应在 0-1 之间`);
            }
        }
    }

    // embedding
    const emb = c.embedding as Record<string, unknown> | undefined;
    if (emb) {
        if (emb.provider && emb.provider !== "openai" && emb.provider !== "local") {
            errors.push("embedding.provider 必须是 \"openai\" 或 \"local\"");
        }
    }

    return { valid: errors.length === 0, errors };
}
