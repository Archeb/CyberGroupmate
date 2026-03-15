/**
 * phase6/index.ts — Pipeline 统一导出
 *
 * 提供 Pipeline 所有组件的集中导入入口。
 */

// ─── 类型 ───
export type {
    Message,
    TopicState,
    Topic,
    InterventionType,

    TriageDecision,
    ExitSignalType,
    ExitSignal,
    ExitStyle,
    QuickTriageOptions,
    QuickTriageResult,
    TopicClusteringResult,
    TopicSummaryTriageResult,
} from "./types.js";
export type { AgentMessageSentEvent } from "./feedback-loop.js";

// ─── 核心组件 ───
export { TopicRegistry } from "./topic-registry.js";
export { RecordingPipeline } from "./recording-pipeline.js";
export { FeedbackLoop } from "./feedback-loop.js";
