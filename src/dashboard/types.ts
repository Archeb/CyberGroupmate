/**
 * dashboard/types.ts — Dashboard 类型定义
 */

import type { SubagentManager } from "../subagent/subagent-manager.js";
import type { DynamicAttentionQueue } from "../subagent/attention-queue.js";
import type { CallbackQueue } from "../subagent/callback-queue.js";
import type { MainAgentLoop } from "../main-agent/main-agent-loop.js";
import type { GlobalState } from "../main-agent/global-state.js";
import type { SandboxPool } from "../sandbox/sandbox-pool.js";
import type { MemoryStoreV2 } from "../memory-v2/index.js";
import type { NotificationCenter } from "../event/notification-center.js";
import type { FeedbackLoop } from "../pipeline/feedback-loop.js";
import type { TokenStatsCollector } from "./token-stats.js";
import type { MediaDownloader } from "../core/media-downloader.js";

/** Dashboard 需要的所有组件引用 */
export interface DashboardDeps {
    nc: NotificationCenter;
    subagentManager: SubagentManager;
    q3: DynamicAttentionQueue;
    q5: CallbackQueue;
    mainLoop: MainAgentLoop;
    globalState: GlobalState;
    sandboxPool: SandboxPool;
    memory: MemoryStoreV2;
    feedbackLoop: FeedbackLoop;
    tokenStats: TokenStatsCollector;
    /** 媒体下载管理器（用于贴纸预览等） */
    mediaDownloader?: MediaDownloader;
}

/** Dashboard 配置 */
export interface DashboardConfig {
    port: number;
    token: string;
    enabled: boolean;
}

/** WebSocket 推送事件 */
export interface WsEvent {
    type: string;
    timestamp: string;
    data: unknown;
}
