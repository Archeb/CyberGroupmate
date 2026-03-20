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
 * 的 topicDigests，同时 emit triage-engage 事件驱动 Q3 入队。
 *
 * 参考设计：subagent.md §3, architecture_v2.md §2.2
 */

import { EventEmitter } from "node:events";
import { Observer } from "./observer.js";
import type {
    AttentionQueueEntry,
    GroupStickiness,
    StickinessLevel,
    SubagentCallback,
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
export class GroupSubagent extends EventEmitter {
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

    /** 最近的 Subagent 回调结果（保留最近 5 条） */
    lastCallbacks: SubagentCallback[] = [];

    /** 自上次 attend 以来，是否有话题通过 triage（ENGAGE），用于 Phase 2 守卫 */
    hasTriageEngaged: boolean = false;

    /** 已分派回复任务的 topicId 集合（防重复分派），值为分派时间戳 */
    private dispatchedTopicIds = new Map<string, number>();

    /** Agent 最后一次回复时间戳（毫秒），用于 triage 防重复 */
    lastAgentReplyAt: number = 0;

    constructor(options: GroupSubagentOptions) {
        super();
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
                log.info("话题通过 Triage", {
                    chatId: this.chatId,
                    topicId: topic.id,
                    label: topic.label,
                    interventionType: decision?.intervention_type,
                    confidence: decision?.confidence,
                });
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

                // 标记有话题需要介入，触发 Q3 重新入队
                this.hasTriageEngaged = true;
                log.info("triage-engage: 话题需要介入，触发 Q3 重入队", {
                    chatId: this.chatId,
                    topicId: topic.id,
                    label: topic.label,
                    digestCount: digests.length,
                });
                this.emit("triage-engage", this.chatId);
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
                mediaType: (event as any).mediaInfo?.type ?? undefined,
                mediaInfo: (event as any).mediaInfo ? JSON.stringify((event as any).mediaInfo) : undefined,
            };
            this.recordingPipeline.onMessage(msg);
        }

        this.touch();
    }

    /**
     * 构建 AttentionQueueEntry（供 Q3 入队）
     */
    buildQueueEntry(sourceOverride?: AttentionQueueEntry["source"]): AttentionQueueEntry {
        const engagement = this.observer.getEngagementScore();
        const alert = this.observer.checkAlert();
        const hasFastPathRequest = this.observer.checkFastPathRequest();
        const basePriority = engagement * this.stickiness.priorityMultiplier;

        // topicDigests: 优先使用 Observer 的 digest（来自 RecordingPipeline triage），
        // 若为空则 fallback 到 TopicRegistry 生成快照（路径 1 入队时 pipeline 可能尚未 flush）
        let topicDigests = this.observer.getDigest();
        if (topicDigests.length === 0) {
            const allTopics = this.topicRegistry.getByChat(this.chatId);
            if (allTopics.length > 0) {
                topicDigests = allTopics.map((t: any) => ({
                    topicId: String(t.id),
                    label: String(t.label ?? ""),
                    summary: String(t.lastSummary ?? t.recentContext ?? ""),
                    state: String(t.state ?? "ACTIVE"),
                    participants: [...(t.participantIds ?? [])].map(String),
                    keywords: Array.isArray(t.keywords) ? t.keywords : [],
                    messageCount: t.messageIds?.length ?? 0,
                    lastActivityAt: String(t.lastMessageAt ?? new Date().toISOString()),
                }));
                log.debug("buildQueueEntry: Observer digest 为空, fallback 到 TopicRegistry", {
                    chatId: this.chatId,
                    topicCount: topicDigests.length,
                });
            }
        }

        // 来源标记：优先使用调用方传入的 sourceOverride（如 DIRECT_ADDRESS）
        const source: AttentionQueueEntry["source"] = sourceOverride
            ?? (alert
                ? "OBSERVER_ALERT"
                : hasFastPathRequest
                    ? "FAST_PATH_REQUEST"
                    : "DIGEST_UPDATE");

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
            topicDigests,
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
        this.hasTriageEngaged = false;  // attend 后重置 triage-engage 标记
        this.pruneDispatchedTopics();   // 清理已归档话题的 dispatched 记录
        log.debug("markAttended", {
            chatId: this.chatId,
            attendCount: this.attendCount,
            dispatchedTopics: this.dispatchedTopicIds.size,
        });
    }



    /**
     * 标记任务已完成（主循环 Phase 1 回调处理时调用）
     */
    markTaskComplete(taskId: string): void {
        this.completedTaskIds.add(taskId);
        log.debug("markTaskComplete", { chatId: this.chatId, taskId });
    }

    /**
     * 记录最近的 Subagent 回调结果（保留最近 5 条）
     */
    addCallback(cb: SubagentCallback): void {
        this.lastCallbacks.push(cb);
        if (this.lastCallbacks.length > 5) {
            this.lastCallbacks = this.lastCallbacks.slice(-5);
        }
        // 有实际发送的消息时，更新 lastAgentReplyAt
        if (cb.sentMessages && cb.sentMessages.length > 0) {
            this.updateLastAgentReplyAt();
        }
    }

    /**
     * 更新 Agent 最后回复时间（同步到 RecordingPipeline）
     */
    updateLastAgentReplyAt(ts: number = Date.now()): void {
        this.lastAgentReplyAt = ts;
        if (this.recordingPipeline) {
            this.recordingPipeline.lastAgentReplyAt = ts;
        }
        // 同步到 CodeActExecutor 以便持久化到 session JSON
        if (this.codeActExecutor && typeof (this.codeActExecutor as any).lastAgentReplyAt !== "undefined") {
            (this.codeActExecutor as any).lastAgentReplyAt = ts;
        }
        log.debug("updateLastAgentReplyAt", { chatId: this.chatId, ts });
    }

    /**
     * 从 CodeActExecutor 恢复 lastAgentReplyAt（进程重启后调用）
     */
    restoreLastAgentReplyAt(): void {
        if (this.codeActExecutor && typeof (this.codeActExecutor as any).lastAgentReplyAt === "number") {
            const restored = (this.codeActExecutor as any).lastAgentReplyAt as number;
            if (restored > 0) {
                this.lastAgentReplyAt = restored;
                if (this.recordingPipeline) {
                    this.recordingPipeline.lastAgentReplyAt = restored;
                }
                log.info("restoreLastAgentReplyAt: 已恢复", { chatId: this.chatId, ts: restored, age: `${Math.round((Date.now() - restored) / 60000)}分钟前` });
            }
        }
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

    // ─── 已分派话题追踪 ───

    /**
     * 标记话题已分派回复任务（dispatch-handler 调用）
     */
    markTopicDispatched(topicId: string): void {
        this.dispatchedTopicIds.set(topicId, Date.now());
        log.info("markTopicDispatched", { chatId: this.chatId, topicId, total: this.dispatchedTopicIds.size });
    }

    /**
     * 检查话题是否已被分派
     */
    isTopicDispatched(topicId: string): boolean {
        return this.dispatchedTopicIds.has(topicId);
    }

    /**
     * 获取所有已分派话题 ID
     */
    getDispatchedTopicIds(): ReadonlySet<string> {
        return new Set(this.dispatchedTopicIds.keys());
    }

    /**
     * 清理已归档/过期的 dispatched 记录（attend 后调用）
     */
    private pruneDispatchedTopics(): void {
        const TTL = 30 * 60 * 1000; // 30 分钟过期
        const now = Date.now();
        for (const [id, dispatchedAt] of this.dispatchedTopicIds) {
            const topic = this.topicRegistry.get(id);
            // 仅清理：(1) registry 中已归档/过期的，或 (2) 超过 TTL 的未知 ID
            // 不清理 registry 中不存在的（可能是 LLM 生成的非 registry 格式 ID）
            if (topic && (topic.state === "ARCHIVED" || topic.state === "STALE")) {
                this.dispatchedTopicIds.delete(id);
                log.debug("pruneDispatchedTopics: 清理(已归档)", { chatId: this.chatId, topicId: id, state: topic.state });
            } else if (now - dispatchedAt > TTL) {
                this.dispatchedTopicIds.delete(id);
                log.debug("pruneDispatchedTopics: 清理(TTL过期)", { chatId: this.chatId, topicId: id, ageMs: now - dispatchedAt });
            }
        }
    }

    /**
     * 从 MemoryV2 恢复最近话题到 TopicRegistry（启动时调用）
     *
     * 查询最近 2 小时的话题，重建 registry 状态。
     * 已回复的话题（wasEngaged）进入 COOLDOWN，避免重复回复。
     *
     * @param memory MemoryV2 实例
     * @returns 恢复的话题数量
     */
    loadRecentTopics(memory: MemoryStoreV2): number {
        const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
        const topicNodes = memory.getTopicsSince(this.chatId, since);

        if (topicNodes.length === 0) {
            log.debug("loadRecentTopics: 无最近话题", { chatId: this.chatId });
            return 0;
        }

        // 将 TopicNode 转为 RestorableTopic
        const restorableTopics: import("../pipeline/topic-registry.js").RestorableTopic[] = topicNodes.map(tn => ({
            id: tn.pipelineTopicId ?? tn.id,  // 优先使用 pipeline ID（registry 用 pipeline ID 作 key）
            chatId: tn.chatId,
            label: tn.label,
            summary: tn.summary,
            keyPoints: tn.keyPoints,
            keywords: tn.keywords,
            participants: tn.participants,
            messageIds: tn.messageRange?.messageIds,
            startedAt: tn.startedAt,
            wasEngaged: tn.wasEngaged,
            interventionCount: tn.interventionCount,
            messageCount: tn.messageRange?.count ?? 0,
        }));

        const restored = this.topicRegistry.restoreFromMemory(restorableTopics);
        log.info("loadRecentTopics", {
            chatId: this.chatId,
            queried: topicNodes.length,
            restored,
            registrySize: this.topicRegistry.size,
        });

        return restored;
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
