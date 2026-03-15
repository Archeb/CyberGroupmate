/**
 * group-subagent.ts — 群组 Subagent 容器
 *
 * 每个群组的 Subagent 容器，持有核心组件：
 * - Observer: 消费消息、计算 Engagement、检测告警
 * - TopicRegistry (per-group): 该群的话题状态机
 * - RecordingPipeline (per-group): 该群的话题聚类 + 记忆沉淀
 * - CodeActExecutor: CodeAct 执行器（S3 实现后注入）
 * - FastPathHandler: 快速回复处理器（S4 实现后注入）
 *
 * RecordingPipeline 的 topic:triage-passed 事件自动更新 Observer
 * 的 topicDigests，不再需要 main.ts 中的外部 bridge。
 *
 * 参考设计：subagent.md §3
 */

import { Observer } from "./observer.js";
import type {
    AttentionQueueEntry,
    GroupStickiness,
    StickinessLevel,
    TopicDigest,
} from "./types.js";
import { createStickiness } from "./stickiness.js";
import { TopicRegistry } from "../pipeline/topic-registry.js";
import { RecordingPipeline } from "../pipeline/recording-pipeline.js";
import type { NotificationEvent } from "../event/notification-center.js";
import type { LLMConfig } from "../core/config.js";
import type { MemoryStoreV2 } from "../memory-v2/index.js";
import type { EmbeddingConfig } from "../core/config.js";
import type { Message } from "../pipeline/types.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("group-subagent");

/** RecordingPipeline 依赖（注入到 GroupSubagent） */
export interface RecordingPipelineDeps {
    llmConfig: LLMConfig;
    personaDescription: string;
    memory?: MemoryStoreV2;
    embeddingConfig?: EmbeddingConfig;
}

/** GroupSubagent 构造参数 */
export interface GroupSubagentOptions {
    chatId: string;
    /** Observer 配置 */
    observerConfig?: ConstructorParameters<typeof Observer>[1];
    /** 初始 stickiness */
    stickiness?: GroupStickiness;
    /** RecordingPipeline 依赖（不传则不创建 pipeline） */
    recordingDeps?: RecordingPipelineDeps;
}

/**
 * GroupSubagent — 群组级 Subagent 容器
 */
export class GroupSubagent {
    readonly chatId: string;
    readonly observer: Observer;

    /** Per-group 话题注册表 */
    readonly topicRegistry: TopicRegistry;

    /** Per-group Recording Pipeline (subagent.md §3.1) */
    readonly recordingPipeline: RecordingPipeline | null;

    /** 群组亲密度 */
    stickiness: GroupStickiness;

    /** 上次被主 Agent attend 的时间 */
    lastAttendedAt: string | null = null;

    /** attend 计数 */
    attendCount: number = 0;

    /** 最后活跃时间 */
    lastActivityAt: number = Date.now();

    /** CodeActExecutor 和 FastPathHandler 预留接口（S3/S4 实现后注入） */
    codeActExecutor: unknown = null;
    fastPathHandler: unknown = null;

    /** 已完成任务 ID 集合（用于状态追踪） */
    private completedTaskIds = new Set<string>();

    constructor(options: GroupSubagentOptions) {
        this.chatId = options.chatId;
        this.observer = new Observer(options.chatId, options.observerConfig);
        this.stickiness = options.stickiness ?? createStickiness("STRANGER");

        // Per-group TopicRegistry + RecordingPipeline
        this.topicRegistry = new TopicRegistry();

        if (options.recordingDeps) {
            const deps = options.recordingDeps;
            this.recordingPipeline = new RecordingPipeline(
                this.topicRegistry,
                deps.llmConfig,
                deps.personaDescription,
                deps.memory,
                deps.embeddingConfig,
            );

            // 自动桥接：RecordingPipeline triage → Observer topicDigests
            this.recordingPipeline.on("topic:triage-passed", (topic: any, decision: any) => {
                log.info("话题通过 Triage", { chatId: this.chatId, topicId: topic.id, label: topic.label });
                const activeTopics = this.topicRegistry.getActive(this.chatId);
                const allNonArchived = this.topicRegistry.getByChat(this.chatId);
                const digests: TopicDigest[] = allNonArchived.map((t: any) => ({
                    topicId: String(t.id),
                    label: String(t.label ?? ""),
                    summary: String(t.summary ?? t.recentContext ?? ""),
                    state: String(t.state ?? "ACTIVE"),
                    participants: [...(t.participantIds ?? [])].map(String),
                    keywords: Array.isArray(t.keywords) ? t.keywords : [],
                    messageCount: t.messageIds?.length ?? 0,
                    lastActivityAt: String(t.lastMessageAt ?? new Date().toISOString()),
                    triageDecision: decision?.should_intervene ? "ENGAGE" as const : "IGNORE" as const,
                    triageConfidence: decision?.confidence ?? 0,
                }));
                this.observer.setTopicDigests(digests);
            });

            // TopicRegistry archived 事件：话题归档时通知 memory
            this.topicRegistry.on("topic:archived", (topic: any) => {
                if (options.recordingDeps?.memory) {
                    options.recordingDeps.memory.finalizeTopic(topic.id);
                }
                log.debug("话题归档", { chatId: this.chatId, topicId: topic.id, label: topic.label });
            });
        } else {
            this.recordingPipeline = null;
        }
    }

    /**
     * 接收消息：同时分发给 Observer 和 RecordingPipeline
     *
     * 替代 main.ts 中单独调用 observer.onMessage() + recordingPipeline.onMessage()
     */
    onMessage(event: NotificationEvent): void {
        // 1. Observer: engagement 计算 + buffer
        this.observer.onMessage(event);

        // 2. RecordingPipeline: 话题聚类 + 记忆沉淀
        if (this.recordingPipeline) {
            const msg: Message = {
                id: String(event.messageId ?? event.id ?? `msg_${Date.now()}`),
                chatId: this.chatId,
                senderId: String(event.userId ?? event.user_id ?? event.senderId ?? ""),
                senderName: String(event.displayName ?? event.senderName ?? event.userName ?? ""),
                text: String(event.text ?? event.message ?? ""),
                timestamp: Date.now(),
                replyToMessageId: event.replyToMessageId ? String(event.replyToMessageId) : undefined,
            };
            this.recordingPipeline.onMessage(msg);
        }

        this.touch();
    }

    /**
     * 构建 AttentionQueueEntry（供 Q3 入队）
     */
    buildQueueEntry(): AttentionQueueEntry {
        const engagement = this.observer.getEngagementScore();
        const alert = this.observer.checkAlert();
        const hasFastPathRequest = this.observer.checkFastPathRequest();
        const basePriority = engagement * this.stickiness.priorityMultiplier;

        // 来源标记 (subagent.md §2.2)
        const source: AttentionQueueEntry["source"] = alert
            ? "OBSERVER_ALERT"
            : hasFastPathRequest
                ? "FAST_PATH_REQUEST"
                : "DIGEST_UPDATE";

        return {
            chatId: this.chatId,
            source,
            priority: basePriority,
            basePriority,
            enqueuedAt: Date.now(),
            lastAttendedAt: this.lastAttendedAt,
            attendCount: this.attendCount,
            blocked: false,
            hasFastPathRequest,
            alert: alert ?? undefined,
            newMessageCount: this.observer.getBufferSize(),
            topicDigests: this.observer.getDigest(),
            stickinessLevel: this.stickiness.level,
            // subagent.md §2.2 补齐
            engagementScore: engagement,
            urgentSignals: this.observer.getMentionCount() > 0 ? ["@mention"] : undefined,
            snapshotTimestamp: new Date().toISOString(),
        };
    }

    /**
     * 标记已被主 Agent attend
     */
    markAttended(): void {
        this.lastAttendedAt = new Date().toISOString();
        this.attendCount++;
        this.observer.clearBuffer();
        log.debug("markAttended", { chatId: this.chatId, attendCount: this.attendCount });
    }

    /**
     * 标记任务已完成（主循环 Phase 1 回调处理时调用）
     */
    markTaskComplete(taskId: string): void {
        this.completedTaskIds.add(taskId);
        log.debug("markTaskComplete", { chatId: this.chatId, taskId });
    }

    /**
     * 检查任务是否已完成
     */
    isTaskCompleted(taskId: string): boolean {
        return this.completedTaskIds.has(taskId);
    }

    /**
     * 更新活跃时间
     */
    touch(): void {
        this.lastActivityAt = Date.now();
    }

    /**
     * 检查是否空闲
     */
    isIdle(maxIdleMs: number): boolean {
        return Date.now() - this.lastActivityAt > maxIdleMs;
    }

    /**
     * 释放资源
     */
    dispose(): void {
        if (this.recordingPipeline) {
            this.recordingPipeline.dispose();
        }
    }
}
