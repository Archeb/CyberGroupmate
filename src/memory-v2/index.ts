/**
 * memory-v2/index.ts — Memory V2 模块统一导出
 *
 * 重新导出 MemoryStoreV2 类和所有相关类型。
 * 消费者只需 import { MemoryStoreV2 } from "./memory-v2/index.js" 即可。
 */

export { MemoryStoreV2 } from "./memory-v2.js";
export { runReflection, parseReflectionJSON, mergeEpisodes, trimProfileByTier, mergeGlobalPersonProfile, mergeProfileList, DEFAULT_TIER_LIMITS, isSizeReducibleError, REFLECTION_SCOPE_LEVELS, type TierLimitEntry, type TierLimitsConfig, type ReflectionScope } from "./reflection.js";
export type { ReflectionExternalConfig as ReflectionConfig } from "../core/config.js";

// Context Manager (M3)
export {
    estimateTokens,
    estimateTokensFallback,
    estimateMessagesTokens,
    shouldCompact,
    classifyMessages,
    identifyProtectedMessages,
    compact,
    forceTrim,
    mergeContextBudget,
    DEFAULT_CONTEXT_BUDGET,
    COMPACT_TRIGGER_RATIO,
    FORCE_TRIM_MARKER,
    type ContextBudget,
    type ClassifiedMessages,
    type ProtectionResult,
    type ForceTrimOptions,
    type ForceTrimResult,
} from "./context-manager.js";

// Embedding (M4)
export {
    embed,
    localEmbed,
    cosineSimilarity,
    dotProduct,
    euclideanSimilarity,
    manhattanSimilarity,
    getSimilarityFn,
    topKSimilar,
    embeddingToBuffer,
    bufferToEmbedding,
} from "./embedding.js";
export type { EmbeddingConfig, SimilarityMetric } from "../core/config.js";
export type { SimilarityFn } from "./embedding.js";

export type {
    // V2 核心类型
    IMemoryStoreV2,
    AssociatedMemory,
    TopicNode,
    PersonIdentity,
    PersonProfile,
    PersonGroupProfile,
    InteractionEpisode,
    MergedMemory,
    GroupModel,
    CoreFact,
    CoreFactProvenance,
    FactCategory,
    FactSearchResult,
    TopicSearchResult,
    MessageSearchResult,
    InteractionSearchResult,
    UserProfileSearchResult,
    MessageLogEntry,
    RecentMessageEntry,
    RecallOptions,
    RecallResult,
    SessionDigestEntry,
    SessionDigestKind,
    SessionDigestActorType,
    SessionDigestSearchOptions,
    TimelineEntry,
    TimelineOptions,
    HistoryBrowseRequest,
    HistoryBrowseResult,
    ReflectionResult,
} from "./types.js";
