/**
 * phase6/index.ts — Phase 6 统一导出
 *
 * 提供 Phase 6A 所有组件的集中导入入口。
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
    RouteResult,
    EngagedRelevance,
    ModelRouteResult,
    ModelRouteRule,
    DryRunConfig,
    DryRunDecision,
    DryRunResult,
    TopicClusteringResult,
    TopicSummaryTriageResult,
} from "./types.js";
export type { ReplyTask, ReplyTaskSource } from "./reply-pipeline.js";
export type { AgentMessageSentEvent } from "./feedback-loop.js";

// ─── 核心组件 ───
export { TopicRegistry } from "./topic-registry.js";
export { RecordingPipeline } from "./recording-pipeline.js";
export { FastRouter } from "./fast-router.js";
export { EngagedTopicHandler } from "./engaged-topic-handler.js";
export { ModelRouter } from "./model-router.js";
export { ReplyPipeline } from "./reply-pipeline.js";
export { FeedbackLoop } from "./feedback-loop.js";
export { ContextAssembler } from "./context-assembler.js";

// ─── Dry-Run ───
export { runDryRun, saveDryRunReport } from "./dry-run.js";
