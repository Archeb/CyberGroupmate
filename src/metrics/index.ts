/**
 * metrics/index.ts — Metrics 模块统一入口
 *
 * 导出 MetricsExporter 和工厂函数 startMetrics()。
 *
 * 使用示例（main.ts）：
 *   const metricsExporter = await startMetrics(deps, appConfig.metrics);
 *   // 在 NC.onPush 中：metricsExporter.groupCollector.onMessage(chatId)
 *   // 在 attend 完成时：metricsExporter.groupCollector.onAttend(chatId, decision)
 */

export { MetricsExporter, type MetricsExporterConfig } from "./exporter.js";
export { LLMCollector } from "./collectors/llm-collector.js";
export { GroupCollector, type GroupCollectorDeps } from "./collectors/group-collector.js";
export { SystemCollector, type SystemCollectorDeps } from "./collectors/system-collector.js";
export { registry } from "./registry.js";

import { MetricsExporter } from "./exporter.js";
import { LLMCollector } from "./collectors/llm-collector.js";
import { GroupCollector } from "./collectors/group-collector.js";
import { SystemCollector } from "./collectors/system-collector.js";
import type { SubagentManager } from "../subagent/subagent-manager.js";
import type { SandboxPool } from "../sandbox/sandbox-pool.js";
import type { CallbackQueue } from "../subagent/callback-queue.js";
import type { MainAgentLoop } from "../main-agent/main-agent-loop.js";
import type { FeedbackLoop } from "../pipeline/feedback-loop.js";
import type { MetricsConfig } from "../core/config.js";
import type { AttentionAccumulator } from "../accumulator/attention-accumulator.js";

/** startMetrics 所需的系统组件依赖 */
export interface MetricsDeps {
    subagentManager: SubagentManager;
    sandboxPool: SandboxPool;
    accumulator: AttentionAccumulator;
    q5: CallbackQueue;
    mainLoop: MainAgentLoop;
    feedbackLoop: FeedbackLoop;
}

/** 完整 Metrics 实例（供 main.ts 保存引用用于 push 事件） */
export interface MetricsInstance {
    exporter: MetricsExporter;
    llmCollector: LLMCollector;
    groupCollector: GroupCollector;
    systemCollector: SystemCollector;
}

/**
 * 工厂函数：初始化所有 collector + HTTP exporter 并启动。
 *
 * @param deps 系统组件依赖
 * @param config metrics 配置（来自 appConfig.metrics）
 * @returns MetricsInstance（已启动）
 */
export async function startMetrics(deps: MetricsDeps, config?: MetricsConfig): Promise<MetricsInstance> {
    const llmCollector = new LLMCollector();

    const groupCollector = new GroupCollector({
        subagentManager: deps.subagentManager,
    });

    const systemCollector = new SystemCollector({
        sandboxPool: deps.sandboxPool,
        accumulator: deps.accumulator,
        q5: deps.q5,
        mainLoop: deps.mainLoop,
        feedbackLoop: deps.feedbackLoop,
    });

    const exporter = new MetricsExporter(groupCollector, systemCollector, {
        host: config?.host,
        port: config?.port,
        path: config?.path,
    });

    await exporter.start();

    return { exporter, llmCollector, groupCollector, systemCollector };
}
