/**
 * dashboard/types.ts — Dashboard 类型定义
 */

import type { SubagentManager } from "../subagent/subagent-manager.js";
import type { CallbackQueue } from "../subagent/callback-queue.js";
import type { MainAgentLoop } from "../main-agent/main-agent-loop.js";
import type { GlobalState } from "../main-agent/global-state.js";
import type { SandboxPool } from "../sandbox/sandbox-pool.js";
import type { MemoryStoreV2 } from "../memory-v2/index.js";
import type { NotificationCenter } from "../event/notification-center.js";
import type { FeedbackLoop } from "../pipeline/feedback-loop.js";
import type { TokenStatsCollector } from "./token-stats.js";
import type { MediaDownloader } from "../core/media-downloader.js";
import type { ImageCatalog } from "../core/image-catalog.js";
import type { PlatformAdapter } from "../adapter/platform-adapter.js";
import type { AppConfig } from "../core/config.js";
import type { AttentionAccumulator } from "../accumulator/attention-accumulator.js";

/** Dashboard 需要的所有组件引用 */
export interface DashboardDeps {
    nc: NotificationCenter;
    subagentManager: SubagentManager;
    accumulator: AttentionAccumulator;
    q5: CallbackQueue;
    mainLoop: MainAgentLoop;
    globalState: GlobalState;
    sandboxPool: SandboxPool;
    memory: MemoryStoreV2;
    feedbackLoop: FeedbackLoop;
    tokenStats: TokenStatsCollector;
    /** 媒体下载管理器（用于贴纸预览等） */
    mediaDownloader?: MediaDownloader;
    /** 图片目录（用于表情包频率追踪和预览） */
    imageCatalog?: ImageCatalog;
    /** 平台 adapter 引用（用于 mute 等控制操作） */
    adapters?: PlatformAdapter[];
    /** Dashboard 保存配置后的回调（用于热应用） */
    onConfigSaved?: (config: AppConfig) => Promise<void> | void;
}

/** Dashboard 配置 */
export interface DashboardConfig {
    /** 监听地址，默认 127.0.0.1 */
    host?: string;
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
