/**
 * phase6/recording-pipeline.ts — Recording Pipeline
 *
 * 后台持续运行的观察者任务。将群聊消息结构化沉淀到记忆系统，
 * 同时维护 TopicRegistry 供 Air-Reading Engine 消费。
 *
 * 核心机制：
 * - 消息缓冲：50 条 OR 2 分钟静默，取先到者
 * - 强信号加速：检测到强信号时缓冲阈值降为 15 条 / 30 秒
 * - 每次 flush 执行 4 步：
 *   1. LLM 话题聚类（cheap model）
 *   2. LLM 话题摘要 + Triage（cheap model）
 *   3. 更新 TopicRegistry
 *   4. Memory V2 写入（upsertTopic + storeMessageBatch + incrementProfileStats）
 */

import { EventEmitter } from "node:events";
import { createLogger } from "../core/logger.js";
import { callLLMWithFallback, type ChatMessage } from "../core/llm.js";
import { loadConfig, resolveComponentProfiles, resolveComponentTimeout, type LLMConfig, type VisionConfig } from "../core/config.js";
import { topicClusteringProvider, topicTriageProvider } from "../context-engine/providers/pipeline-providers.js";
import type { MemoryStoreV2, RecentMessageEntry } from "../memory-v2/index.js";
import { embed } from "../memory-v2/embedding.js";
import type { EmbeddingConfig } from "../core/config.js";
import type { TopicRegistry } from "./topic-registry.js";
import { getRawId, getGroupModelKey, getDunbarTierLabel, ensureCompositeId, getPlatform } from "../core/chat-id.js";
import {
    enrichMessages,
    formatMessageLine,
    normalizeMessageMediaFields,
    type RawMessage,
    type StickerDescriptionLookup,
} from "../core/message-enricher.js";
import type {
    Message,
    TopicClusteringResult,
    TopicSummaryTriageResult,
    Topic,
    TopicState,
} from "./types.js";
import type { RecordingPipelineConfig } from "../core/config.js";
import { buildTopicSignalEntries, type TopicSignalEntry } from "./topic-signal.js";
import type { StickinessLevel } from "../subagent/types.js";

const log = createLogger("recording-pipeline");

interface RecordingMessageContext {
    formattedText: string;
    formattedMessagesById: Map<string, string>;
}

interface RecordingEnrichConfig {
    llmConfig: LLMConfig;
    visionConfig?: VisionConfig;
    visionLlmConfig?: LLMConfig[];
}

// ─── 默认值 ───

/** 静默触发时缓冲区最少消息数（不足则跳过 flush） */
const DEFAULT_MIN_FLUSH_SIZE = 10;
/** 正常缓冲阈值（条数） */
const DEFAULT_NORMAL_THRESHOLD = 50;
/** 加速缓冲阈值（条数） */
const DEFAULT_EAGER_THRESHOLD = 15;
/** 正常静默触发（毫秒） */
const DEFAULT_NORMAL_SILENCE = 2 * 60 * 1000;  // 2 min
/** 加速静默触发（毫秒） */
const DEFAULT_EAGER_SILENCE = 30 * 1000;       // 30 sec
/**
 * 单次 flush 最多处理的消息数，超出的留 buffer 下轮排空。
 * cluster 输出∝消息数、decode 仅 ~40-80 tok/s，批次过大必撞超时；封顶把输出锁在安全区。
 */
const DEFAULT_MAX_FLUSH_BATCH = 120;
/** buffer 总量硬上限：持续失败时防止 unshift 回退让 buffer 无限膨胀（越滚越大死亡螺旋），超出丢最旧。 */
const DEFAULT_MAX_BUFFER_SIZE = 1000;
/** 本轮批次未排空时，下一次自动 flush 的短延迟（毫秒），用于尽快排空积压。 */
const DRAIN_REARM_DELAY_MS = 3000;

/**
 * 把配置里的批次/缓冲上限夹到「有限正整数」，非法值（0/负数/小数/NaN/Infinity）回退默认。
 * 防两个陷阱：maxFlushBatch=0 → slice(0,0) 空批 + 每 3s 空转排空；
 * maxBufferSize=0 → slice(-0)===slice(0) 反而保留整个 buffer、封顶失效。
 */
function clampPositiveInt(value: number | undefined, fallback: number): number {
    if (value == null) return fallback;
    const n = Math.floor(value);
    return Number.isFinite(n) && n >= 1 ? n : fallback;
}



/**
 * RecordingPipeline — 后台消息观察者
 *
 * Events:
 * - `flush:start` (messageCount: number)
 * - `flush:complete` (topics: Topic[])
 * - `flush:error` (error: Error)
 * - `topics:signaled` (signals: TopicSignalEntry[])
 */
export class RecordingPipeline extends EventEmitter {
    private buffer: Message[] = [];
    private isEagerMode = false;
    private silenceTimer: ReturnType<typeof setTimeout> | null = null;
    private isFlushing = false;
    private disposed = false;

    /** Agent 最后回复时间戳（由 GroupSubagent 同步写入），用于 triage 防重复 */
    lastAgentReplyAt: number = 0;

    private readonly minFlushSize: number;
    private readonly normalThreshold: number;
    private readonly eagerThreshold: number;
    private readonly normalSilence: number;
    private readonly eagerSilence: number;
    private readonly maxFlushBatch: number;
    private readonly maxBufferSize: number;

    constructor(
        private registry: TopicRegistry,
        private personaName: string = "赛博群友",
        private personaDescription: string = "赛博群友",
        private memory?: MemoryStoreV2,
        private embeddingConfig?: EmbeddingConfig,
        pipelineConfig?: RecordingPipelineConfig,
        private publishTopicSignals?: (signals: TopicSignalEntry[]) => void,
        private getStickinessLevel: () => StickinessLevel = () => "STRANGER",
    ) {
        super();
        this.minFlushSize = pipelineConfig?.minFlushSize ?? DEFAULT_MIN_FLUSH_SIZE;
        this.normalThreshold = pipelineConfig?.normalThreshold ?? DEFAULT_NORMAL_THRESHOLD;
        this.eagerThreshold = pipelineConfig?.eagerThreshold ?? DEFAULT_EAGER_THRESHOLD;
        this.normalSilence = pipelineConfig?.normalSilenceMs ?? DEFAULT_NORMAL_SILENCE;
        this.eagerSilence = pipelineConfig?.eagerSilenceMs ?? DEFAULT_EAGER_SILENCE;
        this.maxFlushBatch = clampPositiveInt(pipelineConfig?.maxFlushBatch, DEFAULT_MAX_FLUSH_BATCH);
        this.maxBufferSize = clampPositiveInt(pipelineConfig?.maxBufferSize, DEFAULT_MAX_BUFFER_SIZE);
    }

    /**
     * 消息入口 — 由 FastRouter 调用
     */
    onMessage(msg: Message): void {
        if (this.disposed) return;

        this.buffer.push(msg);

        // 重置静默计时器
        this.resetSilenceTimer();

        // 检查是否达到 flush 阈值
        const threshold = this.isEagerMode ? this.eagerThreshold : this.normalThreshold;
        if (this.buffer.length >= threshold) {
            this.triggerFlush();
            return;
        }

        // 检测强信号
        if (!this.isEagerMode && this.hasStrongSignal(msg)) {
            this.isEagerMode = true;
            log.debug("强信号检测，切换到加速模式", { msgId: msg.id });
            // 重置静默定时器为更短的间隔
            this.resetSilenceTimer();
        }
    }

    /**
     * 强信号检测
     */
    private hasStrongSignal(msg: Message): boolean {
        if (!msg.text) return false;
        return (
            msg.text.includes("?") ||
            msg.text.includes("？") ||
            msg.text.includes("吗") ||
            msg.text.length > 200 ||
            this.matchesHotTopicKeywords(msg)
        );
    }

    /**
     * 检查是否匹配已知热门话题关键词
     */
    private matchesHotTopicKeywords(msg: Message): boolean {
        if (!msg.text) return false;
        const activeTopics = this.registry.getActive(msg.chatId);
        for (const topic of activeTopics) {
            for (const kw of topic.keywords) {
                if (msg.text.includes(kw)) return true;
            }
        }
        return false;
    }

    /**
     * 重置静默计时器
     */
    private resetSilenceTimer(): void {
        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
        }
        const silence = this.isEagerMode ? this.eagerSilence : this.normalSilence;
        this.silenceTimer = setTimeout(() => {
            this.triggerFlush();
        }, silence);
    }

    /**
     * 触发 flush
     */
    private triggerFlush(): void {
        if (this.isFlushing || this.buffer.length === 0) return;
        // 静默触发时检查最低消息数（条数阈值触发的已在 onMessage 中保证）
        if (this.buffer.length < this.minFlushSize) {
            log.debug("静默触发跳过：buffer 消息数不足", {
                bufferSize: this.buffer.length,
                minFlushSize: this.minFlushSize,
            });
            // 重置计时器，等待更多消息
            this.resetSilenceTimer();
            return;
        }
        // 使用 void 忽略 Promise 返回值
        void this.flush();
    }

    /**
     * 核心 flush 流程（4 步）
     */
    async flush(options?: { clusterOnly?: boolean }): Promise<void> {
        if (this.isFlushing || this.buffer.length === 0) return;

        this.isFlushing = true;
        // 批次上限：单次最多处理 maxFlushBatch 条，其余留在 buffer 下轮排空。
        // 输出∝消息数、decode ~40-80 tok/s，批次过大 cluster 必撞超时——封顶从根上锁死单次输出体积。
        const messages = this.buffer.slice(0, this.maxFlushBatch);
        this.buffer = this.buffer.slice(this.maxFlushBatch);
        this.isEagerMode = false;  // 每次 flush 后重置
        const clusterOnly = options?.clusterOnly ?? false;

        log.info("flush 开始", { messageCount: messages.length, remaining: this.buffer.length, clusterOnly });
        this.emit("flush:start", messages.length);

        let hadError = false;
        try {
            // ─── Step 1: 话题聚类 ───
            const groupedByChat = this.groupByChat(messages);

            for (const [chatId, chatMessages] of groupedByChat) {
                const existingTopics = this.registry.getByChat(chatId);
                const messageContext = await this.buildRecordingMessageContext(chatMessages, chatId);

                let clustering = await this.llmTopicClustering(chatMessages, existingTopics, messageContext);

                // 防御性兜底：llmTopicClustering 已保证非空有效 assignments。万一未来回归导致空结果，
                // 也走本地默认归类而非 unshift 回 buffer——后者会被 finally 的 re-arm 当成功重排，
                // 让同批消息 3s 后再跑一次、无限循环（死亡螺旋）。绝不把消息写回 buffer。
                if (clustering.assignments.length === 0) {
                    log.warn("聚类结果为空，使用本地默认归类（不回退 buffer）", {
                        chatId,
                        messageCount: chatMessages.length,
                    });
                    clustering = this.fallbackClustering(chatMessages);
                }

                // ─── Step 2: 摘要 + Triage（clusterOnly 模式跳过）───
                const triageResult = clusterOnly
                    ? { topics: [] } as TopicSummaryTriageResult
                    : await this.llmTopicSummaryTriage(chatMessages, clustering, chatId, messageContext);

                // ─── Step 3: 更新 TopicRegistry ───
                const {
                    topics: updatedTopics,
                    signalReadyTopics,
                    clusterIdMap,
                    topicMessagesById,
                } = this.updateRegistry(chatId, chatMessages, clustering, triageResult, messageContext.formattedMessagesById);

                // ─── Step 4: Memory V2 写入 ───
                if (this.memory) {
                    // 写入话题节点
                    for (const topic of updatedTopics) {
                        // 用 clusterIdMap 将真实 ID 映射回 clustering 临时 ID，解决 NEW_x → topic_xxx 的不匹配
                        const clusterTopicId = clusterIdMap.get(topic.id) ?? topic.id;
                        const triage = triageResult.topics.find(t => t.topicId === clusterTopicId);
                        this.memory.upsertTopic(topic.id, {
                            chatId: String(chatId),
                            label: topic.label,
                            // 仅在有 triage 结果时写入 summary，避免后续 flush 覆写已有数据
                            ...(triage?.summary ? { summary: triage.summary } : {}),
                            keywords: topic.keywords,
                            participants: [...topic.participantIds].map(id => ensureCompositeId(getPlatform(chatId), String(id))),
                            messageRange: {
                                messageIds: topic.messageIds,
                                count: topic.messageCount,
                            },
                            startedAt: new Date(topic.createdAt).toISOString(),
                        });
                    }

                    for (const topic of updatedTopics) {
                        const association = this.computeTopicAssociations(topic, chatId);
                        topic.associatedMemories = association.associatedMemories;
                        topic.callbackPotential = association.callbackPotential;
                        this.memory.upsertTopic(topic.id, {
                            associatedMemories: association.associatedMemories,
                            callbackPotential: association.callbackPotential,
                        });
                    }

                    // 批量写入原始消息到 message_log
                    this.memory.storeMessageBatch(chatMessages.map(m => ({
                        messageId: m.id,
                        chatId: String(m.chatId),
                        userId: ensureCompositeId(getPlatform(chatId), String(m.senderId)),
                        displayName: m.senderName,
                        text: m.text,
                        replyToMessageId: m.replyToMessageId,
                        timestamp: new Date(m.timestamp).toISOString(),
                        mediaType: m.mediaType,
                        mediaInfo: m.mediaInfo,
                    })));

                    // 更新参与者身份信息 + 群内画像统计
                    const seenUsers = new Set<string>();
                    const userStats = new Map<string, { count: number; hours: number[]; lastTs: string }>();

                    for (const m of chatMessages) {
                        if (!seenUsers.has(m.senderId)) {
                            seenUsers.add(m.senderId);
                            this.memory.upsertPersonIdentity(ensureCompositeId(getPlatform(chatId), String(m.senderId)), {
                                displayName: m.senderName,
                                ...(m.senderUsername ? { username: m.senderUsername } : {}),
                                lastSeenAt: new Date(m.timestamp).toISOString(),
                            });
                        }

                        // 累计每用户的消息统计
                        let s = userStats.get(m.senderId);
                        if (!s) {
                            s = { count: 0, hours: new Array(24).fill(0), lastTs: "" };
                            userStats.set(m.senderId, s);
                        }
                        s.count++;
                        const hour = new Date(m.timestamp).getHours();
                        s.hours[hour]++;
                        const ts = new Date(m.timestamp).toISOString();
                        if (ts > s.lastTs) s.lastTs = ts;
                    }

                    // 批量更新群内画像统计（messageCount/activeHours/lastSeenAt）
                    for (const [uid, s] of userStats) {
                        this.memory.incrementProfileStats(ensureCompositeId(getPlatform(chatId), String(uid)), String(chatId), {
                            messageCountDelta: s.count,
                            activeHoursDelta: s.hours,
                            lastSeenAt: s.lastTs,
                        });
                    }

                    if (!clusterOnly) {
                        this.publishSignals(chatId, signalReadyTopics, topicMessagesById);
                    }

                    // M4.5: 生成 topic embedding（异步：话题已落盘，向量后台补齐，不阻塞 pipeline flush）
                    if (this.embeddingConfig) {
                        const embCfg = this.embeddingConfig;
                        const mem = this.memory; // 捕获到局部：异步闭包内丢失 this.memory 的窄化
                        const summaries = updatedTopics
                            .filter(t => {
                                const cid = clusterIdMap.get(t.id) ?? t.id;
                                const triage = triageResult.topics.find(tr => tr.topicId === cid);
                                return triage?.summary;
                            })
                            .map(t => {
                                const cid = clusterIdMap.get(t.id) ?? t.id;
                                const triage = triageResult.topics.find(tr => tr.topicId === cid);
                                return { id: t.id, text: `${t.label} ${triage?.summary ?? ""}` };
                            });

                        if (summaries.length > 0) {
                            void (async () => {
                                try {
                                    const embeddings = await embed(summaries.map(s => s.text), embCfg);
                                    for (let i = 0; i < summaries.length; i++) {
                                        const s = summaries[i];
                                        const e = embeddings[i];
                                        if (s && e) mem.upsertTopic(s.id, { embedding: e });
                                    }
                                    log.debug("Pipeline Step 4: embedding 生成完成（异步）", { count: summaries.length });
                                } catch (err) {
                                    log.warn("Pipeline Step 4: embedding 生成失败", { error: String(err) });
                                }
                            })();
                        }
                    }

                    log.debug("Memory V2 写入完成", {
                        topicCount: updatedTopics.length,
                        messageCount: chatMessages.length,
                        userCount: seenUsers.size,
                    });
                } else {
                    if (!clusterOnly) {
                        this.publishSignals(chatId, signalReadyTopics, topicMessagesById);
                    }
                    log.debug("Memory V2 写入（无 memory 实例，跳过）", { topicCount: updatedTopics.length });
                }

                this.emit("flush:complete", updatedTopics);
            }
        } catch (err) {
            hadError = true;
            log.error("flush 失败", { error: err instanceof Error ? err.message : String(err) });
            this.emit("flush:error", err);
            // 把消息放回缓冲头部，避免丢失
            this.buffer.unshift(...messages);
            // 保底回退：buffer 总量封顶。持续失败时（非 LLM 错误，如落盘异常）unshift 会让 buffer 无限膨胀，
            // 批次越滚越大 → 更必然失败＝死亡螺旋。超出上限即丢弃最旧（含反复失败的批次），保留最新消息、自愈。
            if (this.buffer.length > this.maxBufferSize) {
                const dropped = this.buffer.length - this.maxBufferSize;
                this.buffer = this.buffer.slice(-this.maxBufferSize);
                log.warn("buffer 超过上限，丢弃最旧消息以防死亡螺旋", { dropped, cap: this.maxBufferSize });
            }
        } finally {
            this.isFlushing = false;
            // 本轮批次上限有溢出（或回退的消息）→ 短延迟后继续排空，别干等下一条消息/静默定时器。
            // unref：这条排空定时器不该独自把进程吊住（长活进程无所谓，测试/退出时要能干净结束）。
            if (this.shouldRearmDrain(hadError)) {
                const drainTimer = setTimeout(() => { void this.flush(); }, DRAIN_REARM_DELAY_MS);
                drainTimer.unref?.();
            }
        }
    }

    /**
     * flush 收尾时是否安排「排空定时器」继续处理积压。
     * - 成功路径：只要 buffer 还有余量就排空——含 < minFlushSize 的尾巴（如批次上限切剩的 1–9 条），
     *   否则这段尾巴会一直滞留到该群下次活跃/静默触发才落盘。
     * - 失败路径：沿用 minFlushSize 阈值。持续失败（非 LLM 错误，如落盘异常）时若无脑排空，
     *   会变成每 3s 对同一小批次热重试刷屏；保留阈值让小残留等更多消息再一起重试。
     */
    private shouldRearmDrain(hadError: boolean): boolean {
        if (this.disposed || this.buffer.length === 0) return false;
        return hadError ? this.buffer.length >= this.minFlushSize : true;
    }

    /**
     * Step 1: LLM 话题聚类
     */
    private async llmTopicClustering(
        messages: Message[],
        existingTopics: Topic[],
        messageContext?: RecordingMessageContext,
    ): Promise<TopicClusteringResult> {
        // 取最近 10 个话题（按活跃时间倒排），避免上下文过长
        const recentTopics = existingTopics
            .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
            .slice(0, 10);

        const existingTopicsStr = recentTopics.length > 0
            ? recentTopics.map(t => {
                const parts = [`- ${t.id}: "${t.label}" [${t.state}] (关键词: ${t.keywords.join(", ")})`];
                parts.push(`  消息数: ${t.messageCount}, 参与人数: ${t.participantIds.size}`);
                if (t.recentContext) {
                    parts.push(`  最近消息:\n${t.recentContext.split("\n").map(l => `    ${l}`).join("\n")}`);
                }
                return parts.join("\n");
            }).join("\n")
            : "（暂无已有话题）";

        const messagesStr = messageContext?.formattedText
            ?? (await this.buildRecordingMessageContext(messages, messages[0]?.chatId ?? "")).formattedText;

        const prompt = topicClusteringProvider.render({
            existingTopics: existingTopicsStr,
            messages: messagesStr,
        });

        const llmMessages: ChatMessage[] = [
            { role: "system", content: "你是一个话题聚类助手。只输出合法 JSON，不要任何其他内容。" },
            { role: "user", content: prompt },
        ];

        let response;
        try {
            response = await callLLMWithFallback(llmMessages, resolveComponentProfiles("recording_cluster"), { caller: "recording-cluster", component: "recording_cluster", timeoutMs: resolveComponentTimeout("recording_cluster") });
        } catch (err) {
            // 保底回退：LLM 彻底失败（超时/网关，所有 profile+重试用尽）时不抛出，降级为本地单话题归类。
            // 关键：这样本批次仍被记录并从 buffer 排空，绝不把整批 unshift 回 buffer 头触发死亡螺旋。
            log.warn("话题聚类 LLM 调用失败，保底降级为单话题归类", {
                error: err instanceof Error ? err.message : String(err),
                messageCount: messages.length,
            });
            return this.fallbackClustering(messages);
        }

        // LLM 调用成功、返回内容 → 交给归一化校验（解析失败 / 合法但语义空或无效 → 本地默认归类）。
        return this.normalizeClusteringResult(response.content, messages);
    }

    /**
     * 归一化 + 校验 cluster LLM 的原始输出。
     *
     * 关键不变量：**永不返回空 assignments**。空结果会被 flush() 视为「成功但没产出」，
     * 若把消息 unshift 回 buffer，finally 的 re-arm 会把它当成功重排 → 同批消息 3s 后再跑一次
     * → 无限循环（死亡螺旋）。因此这里把以下软失败全部降级为本地默认归类：
     * - JSON 解析失败（raw 非合法 JSON）
     * - 合法 JSON 但缺 assignments 数组
     * - 合法 JSON 但 assignments 为空 / 全部无效（messageId 不在本批 / topicId 空）
     * 日志按类别区分，便于与 LLM 调用失败（在 llmTopicClustering catch 处告警）对账。
     *
     * 部分有效时保留有效项，并给未被覆盖的消息补默认归类，保证消息绝不静默丢失。
     */
    private normalizeClusteringResult(rawContent: string, messages: Message[]): TopicClusteringResult {
        let parsed: { assignments?: unknown; evolutions?: unknown };
        try {
            // 提取 JSON（处理可能的 markdown 包裹）
            const jsonStr = rawContent
                .replace(/```json\s*/g, "")
                .replace(/```\s*/g, "")
                .trim();
            parsed = JSON.parse(jsonStr) as { assignments?: unknown; evolutions?: unknown };
        } catch {
            log.warn("话题聚类 LLM 输出 JSON 解析失败，使用本地默认归类", { raw: rawContent.slice(0, 200) });
            return this.fallbackClustering(messages);
        }

        if (!Array.isArray(parsed.assignments)) {
            log.warn("话题聚类 LLM 输出合法但缺 assignments 数组，使用本地默认归类", {
                raw: rawContent.slice(0, 200),
                messageCount: messages.length,
            });
            return this.fallbackClustering(messages);
        }

        // 过滤非法 assignment：messageId 必须指向本批真实消息、topicId 必须非空字符串。
        const messageIds = new Set(messages.map(m => m.id));
        const validAssignments = (parsed.assignments as unknown[]).filter(
            (a): a is TopicClusteringResult["assignments"][number] =>
                typeof a === "object" && a !== null &&
                typeof (a as { messageId?: unknown }).messageId === "string" &&
                messageIds.has((a as { messageId: string }).messageId) &&
                typeof (a as { topicId?: unknown }).topicId === "string" &&
                (a as { topicId: string }).topicId.trim().length > 0,
        );

        if (validAssignments.length === 0) {
            log.warn("话题聚类 LLM 输出合法但 assignments 为空或全部无效，使用本地默认归类", {
                raw: rawContent.slice(0, 200),
                messageCount: messages.length,
            });
            return this.fallbackClustering(messages);
        }

        // 覆盖完整性：给任何未被有效 assignment 覆盖的消息补默认归类，绝不让消息静默丢失。
        const assignedIds = new Set(validAssignments.map(a => a.messageId));
        const missingMessages = messages.filter(m => !assignedIds.has(m.id));
        if (missingMessages.length > 0) {
            log.warn("话题聚类 LLM 漏归部分消息，未覆盖部分补默认归类", {
                missing: missingMessages.length,
                total: messages.length,
            });
        }

        return {
            assignments: [
                ...validAssignments,
                ...missingMessages.map(m => ({
                    messageId: m.id,
                    topicId: "NEW_FALLBACK",
                    topicLabel: "对话讨论",
                    keywords: [] as string[],
                })),
            ],
            evolutions: Array.isArray(parsed.evolutions)
                ? (parsed.evolutions as TopicClusteringResult["evolutions"])
                : [],
        };
    }

    /**
     * 保底降级归类：LLM 不可用（超时/网关挂/输出解析失败）时，把整批消息归为一个新话题。
     * 目的是保证消息仍被落盘、buffer 被排空——牺牲话题粒度换取「绝不死循环」。
     */
    private fallbackClustering(messages: Message[]): TopicClusteringResult {
        return {
            assignments: messages.map(m => ({
                messageId: m.id,
                topicId: "NEW_1",
                topicLabel: "对话讨论",
                keywords: [],
            })),
            evolutions: [],
        };
    }

    /**
     * Step 2: LLM 话题摘要 + Triage
     */
    private async llmTopicSummaryTriage(
        messages: Message[],
        clustering: TopicClusteringResult,
        chatId: string,
        messageContext?: RecordingMessageContext,
    ): Promise<TopicSummaryTriageResult> {
        // 按话题分组本批次消息
        const topicGroups = new Map<string, Message[]>();
        for (const assignment of clustering.assignments) {
            const msg = messages.find(m => m.id === assignment.messageId);
            if (!msg) continue;
            const group = topicGroups.get(assignment.topicId) ?? [];
            group.push(msg);
            topicGroups.set(assignment.topicId, group);
        }

        // 构建每个话题的上下文字符串
        const allTopicIds = Array.from(topicGroups.keys());
        const topicMessagesStr = this.buildTopicContextStr(
            allTopicIds,
            topicGroups,
            clustering,
            messageContext?.formattedMessagesById,
        );

        const prompt = topicTriageProvider.render({
            personaName: this.personaName,
            persona: this.personaDescription,
            rules: "",
        });

        // 构建富化的 user message：群组信息 + 参与者画像 + 话题上下文
        const contextSections: string[] = [];
        contextSections.push(...this.buildTriageContext(chatId, messages));
        contextSections.push(topicMessagesStr);
        contextSections.push("请根据以上信息，对每个话题进行摘要和 triage，严格遵循格式输出 JSON.");
        const userMessage = contextSections.join("\n\n");

        const llmMessages: ChatMessage[] = [
            { role: "system", content: prompt },
            { role: "user", content: userMessage },
        ];

        let response;
        try {
            response = await callLLMWithFallback(llmMessages, resolveComponentProfiles("recording_triage"), { caller: "recording-triage", component: "recording_triage", timeoutMs: resolveComponentTimeout("recording_triage") });
        } catch (err) {
            // 保底回退：triage LLM 彻底失败时不抛出（否则 flush 进 catch → 回退 buffer → 死亡螺旋）。
            // 返回空 triage：话题仍按 clustering 落盘，仅缺 LLM 摘要（后续 reflection 可补）。
            log.warn("话题摘要 Triage LLM 调用失败，跳过摘要（话题仍落盘）", {
                error: err instanceof Error ? err.message : String(err),
            });
            return { topics: [] };
        }

        let result: TopicSummaryTriageResult;
        try {
            const jsonStr = response.content
                .replace(/```json\s*/g, "")
                .replace(/```\s*/g, "")
                .trim();
            result = JSON.parse(jsonStr) as TopicSummaryTriageResult;
        } catch {
            log.warn("话题摘要 Triage LLM 输出解析失败", { raw: response.content.slice(0, 200) });
            return { topics: [] };
        }

        // ─── 输出完整性校验 + 重试 ───
        const returnedIds = new Set(result.topics.map(t => t.topicId));
        const missingIds = allTopicIds.filter(id => !returnedIds.has(id));

        if (missingIds.length > 0) {
            log.warn("Step 2 LLM 遗漏话题，启动补全重试", {
                expected: allTopicIds.length,
                returned: returnedIds.size,
                missingIds,
            });

            // 只对缺失的话题重跑一次
            const retryStr = this.buildTopicContextStr(
                missingIds,
                topicGroups,
                clustering,
                messageContext?.formattedMessagesById,
            );
            const retryPrompt = topicTriageProvider.render({
                personaName: this.personaName,
                persona: this.personaDescription,
                rules: "",
            });

            const retryMessages: ChatMessage[] = [
                { role: "system", content: retryPrompt },
                { role: "user", content: retryStr + "\n\n请根据以上信息，对每个话题进行摘要和 triage，严格遵循格式输出 JSON." },
            ];

            try {
                const retryResponse = await callLLMWithFallback(retryMessages, resolveComponentProfiles("recording_triage"), { caller: "recording-triage", component: "recording_triage", timeoutMs: resolveComponentTimeout("recording_triage") });
                const retryJson = retryResponse.content
                    .replace(/```json\s*/g, "")
                    .replace(/```\s*/g, "")
                    .trim();
                const retryResult = JSON.parse(retryJson) as TopicSummaryTriageResult;
                result.topics.push(...retryResult.topics);

                const stillMissing = missingIds.filter(
                    id => !retryResult.topics.some(t => t.topicId === id)
                );
                if (stillMissing.length > 0) {
                    log.error("Step 2 重试后仍有话题缺失", { stillMissing });
                }
            } catch (retryErr) {
                log.error("Step 2 补全重试失败", { error: String(retryErr), missingIds });
            }
        }

        return result;
    }

    private async buildRecordingMessageContext(messages: Message[], chatId: string): Promise<RecordingMessageContext> {
        const stickerDescriptionLookup = this.getStickerDescriptionLookup();
        const rawMessages = this.buildRecordingRawMessages(messages, chatId);
        const enrichConfig = this.resolveRecordingEnrichConfig();
        const enriched = await enrichMessages(rawMessages, {
            llmConfig: enrichConfig.llmConfig,
            visionConfig: enrichConfig.visionConfig,
            visionLlmConfig: enrichConfig.visionLlmConfig,
            chatId,
            stickerDescriptionLookup,
            enableMediaProcessing: false,
            enableMediaDownload: false,
            enableOgPreview: false,
        });
        const formattedMessagesById = new Map<string, string>();
        for (const raw of rawMessages) {
            if (!raw.id) continue;
            formattedMessagesById.set(raw.id, formatMessageLine(raw, {
                includeMediaTags: true,
                stickerDescriptionLookup,
            }));
        }
        return {
            formattedText: enriched.formattedText,
            formattedMessagesById,
        };
    }

    private resolveRecordingEnrichConfig(): RecordingEnrichConfig {
        const config = loadConfig();
        const llmConfig = resolveComponentProfiles("recording_cluster", config)[0];
        if (!llmConfig) {
            throw new Error("No LLM profile configured for recording_cluster");
        }
        return {
            llmConfig,
            visionConfig: config.vision,
            visionLlmConfig: config.llmRouting.vision
                ? resolveComponentProfiles("vision", config)
                : undefined,
        };
    }

    private buildRecordingRawMessages(messages: Message[], chatId: string): RawMessage[] {
        const batchById = new Map(messages.map((message) => [message.id, message]));
        const missingReplyIds = [...new Set(messages
            .map((message) => message.replyToMessageId)
            .filter((messageId): messageId is string => !!messageId && !batchById.has(messageId))
        )];
        const memoryReplies = new Map<string, RecentMessageEntry>();

        if (this.memory && missingReplyIds.length > 0) {
            try {
                for (const entry of this.memory.getMessagesByIds(String(chatId), missingReplyIds)) {
                    memoryReplies.set(entry.messageId, entry);
                }
            } catch (err) {
                log.debug("recording 消息 reply 上下文读取失败", { chatId, error: String(err) });
            }
        }

        return messages.map((message) => {
            const replyId = message.replyToMessageId;
            const batchReply = replyId ? batchById.get(replyId) : undefined;
            const memoryReply = replyId && !batchReply ? memoryReplies.get(replyId) : undefined;
            const replyRaw = batchReply
                ? this.rawMessageFromPipelineMessage(batchReply)
                : memoryReply
                    ? this.rawMessageFromMemoryEntry(memoryReply)
                    : undefined;
            return this.rawMessageFromPipelineMessage(message, replyRaw);
        });
    }

    private rawMessageFromPipelineMessage(message: Message, replyRaw?: RawMessage): RawMessage {
        const normalized = normalizeMessageMediaFields(message.mediaInfo, message.text);
        const replyToMsgId = message.replyToMessageId;
        return {
            id: message.id,
            sender: message.senderName?.trim() || message.senderId || "unknown",
            text: message.text,
            timestamp: new Date(message.timestamp).toISOString(),
            replyTo: replyToMsgId ? (replyRaw?.sender ?? `msg#${replyToMsgId}`) : undefined,
            replyToMsgId,
            replyToText: replyRaw ? this.formatReplyTargetText(replyRaw) : undefined,
            mediaType: message.mediaType ?? normalized.mediaType,
            mediaInfo: normalized.mediaInfo ?? message.mediaInfo,
            chatId: message.chatId,
        };
    }

    private rawMessageFromMemoryEntry(entry: RecentMessageEntry): RawMessage {
        const normalized = normalizeMessageMediaFields(entry.mediaInfo, entry.text);
        return {
            id: entry.messageId,
            sender: entry.displayName?.trim() || entry.userId || "unknown",
            text: entry.text,
            timestamp: entry.timestamp,
            mediaType: entry.mediaType ?? normalized.mediaType,
            mediaInfo: normalized.mediaInfo ?? entry.mediaInfo,
            chatId: entry.chatId,
        };
    }

    private formatReplyTargetText(raw: RawMessage): string | undefined {
        const line = formatMessageLine({
            ...raw,
            sender: "reply_target",
            replyTo: undefined,
            replyToMsgId: undefined,
            replyToText: undefined,
        }, {
            includeMediaTags: true,
            stickerDescriptionLookup: this.getStickerDescriptionLookup(),
        });
        const marker = " reply_target: ";
        const markerIndex = line.indexOf(marker);
        const content = (markerIndex >= 0 ? line.slice(markerIndex + marker.length) : raw.text ?? "").trim();
        return content || undefined;
    }

    private formatTopicMessageLines(messages: Message[], formattedMessagesById?: Map<string, string>): string {
        return messages.map((message) => `  ${this.formatTopicContextLine(message, formattedMessagesById)}`).join("\n");
    }

    private formatTopicContextLine(message: Message, formattedMessagesById?: Map<string, string>): string {
        const preformatted = formattedMessagesById?.get(message.id);
        if (preformatted) return preformatted;
        return formatMessageLine(this.rawMessageFromPipelineMessage(message), {
            includeMediaTags: true,
            stickerDescriptionLookup: this.getStickerDescriptionLookup(),
        });
    }

    private applyEnrichedRecentContext(
        topic: Topic,
        contextLines: string[],
        existingLines: string[] = [],
        maxLines = 8,
    ): void {
        topic.recentContext = [...existingLines, ...contextLines].slice(-maxLines).join("\n");
    }

    private getStickerDescriptionLookup(): StickerDescriptionLookup | undefined {
        if (!this.memory) return undefined;
        return {
            getStickerDescription: (uniqueFileId: string) => this.memory!.getStickerDescription(uniqueFileId),
        };
    }

    /**
     * 构建话题上下文字符串（供 Step 2 prompt 使用）
     *
     * 对旧话题：附带 label、上一轮 summary/reason、recentContext 历史消息
     * 对新话题：只含本批次消息
     */
    private buildTopicContextStr(
        topicIds: string[],
        topicGroups: Map<string, Message[]>,
        clustering: TopicClusteringResult,
        formattedMessagesById?: Map<string, string>,
    ): string {
        return topicIds.map(topicId => {
            const msgs = topicGroups.get(topicId) ?? [];
            const newMsgLines = this.formatTopicMessageLines(msgs, formattedMessagesById);

            // 尝试获取旧话题
            const topic = this.registry.get(topicId);

            if (!topic) {
                // 新话题（或者是 LLM 编造的临时 ID，不在 registry 中）
                const label = clustering.assignments.find(a => a.topicId === topicId)?.topicLabel ?? topicId;
                return `### 话题: ${label} (ID: ${topicId})\n${newMsgLines}`;
            }

            // 旧话题：从 registry 取完整上下文
            const label = topic?.label ?? topicId;
            const parts: string[] = [`### 话题: ${label} (ID: ${topicId}) [持续话题]`];

            // 上一轮的摘要信息
            if (topic?.lastSummary) {
                parts.push(`  上一轮摘要: ${topic.lastSummary}`);
            }
            if (topic?.decision?.reason) {
                parts.push(`  上一轮判断: ${topic.decision.reason}`);
            }

            // 历史消息上下文
            if (topic?.recentContext) {
                parts.push(`  历史消息:`);
                for (const line of topic.recentContext.split("\n")) {
                    parts.push(`    ${line}`);
                }
            }

            // 本轮新消息
            parts.push(`  本轮新消息:`);
            parts.push(newMsgLines);

            return parts.join("\n");
        }).join("\n\n");
    }

    /**
     * 构建 Triage 富化上下文（群组信息 + 参与者画像 + 事实）
     *
     * 从 MemoryV2 获取群组模型、参与者画像和核心事实，
     * 使 triage LLM 能理解群组动态、人际关系、和已知事实。
     */
    private buildTriageContext(chatId: string, messages: Message[]): string[] {
        if (!this.memory) return [];

        const sections: string[] = [];

        // --- 群组信息 ---
        const groupModel = this.memory.getGroupModel(getGroupModelKey(chatId));
        if (groupModel) {
            const isDirectMessage = !!groupModel.isDirectMessage;
            if (isDirectMessage) {
                sections.push(`## 私聊信息\n` +
                    `- 对话对象: ${groupModel.chatTitle}\n` +
                    `- 我的角色: ${groupModel.agentRole || "(未定义)"}\n` +
                    `- 聊天类型: 一对一私聊`);
            } else {
                sections.push(`## 群组信息\n` +
                    `- 群名: ${groupModel.chatTitle}\n` +
                    `- 我的角色: ${groupModel.agentRole || "(未定义)"}\n` +
                    `- 活跃度: ${groupModel.engagementLevel || "(未知)"}\n` +
                    (groupModel.hotTopics?.length ? `- 热点话题: ${groupModel.hotTopics.join(", ")}` : ""));
            }
        }

        // --- 参与者画像 ---
        const profiles = this.memory.getProfilesForChat(chatId);
        // 只展示本批消息中出现的发言者，避免占用过多 token
        const activeSenderIds = new Set(messages.map(m => m.senderId));
        const relevantProfiles = profiles.filter(p => {
            const rawId = getRawId(p.userId);
            return activeSenderIds.has(p.userId) || activeSenderIds.has(rawId);
        });

        if (relevantProfiles.length > 0) {
            const profileLines = relevantProfiles.map(p => {
                const identity = this.memory!.getPersonIdentity(p.userId);
                const namePart = identity?.username ? ` (@${identity.username})` : "";
                const parts = [
                    `- **${this.formatUserLabel(p.userId)}**${namePart}`,
                    "关系：" + getDunbarTierLabel(p.dunbarTier),
                    p.traits.length ? `traits=[${p.traits.join(", ")}]` : null,
                    p.interests.length ? `interests=[${p.interests.join(", ")}]` : null,
                    p.relationToAgent ? `relation="${p.relationToAgent}"` : null,
                ].filter(Boolean).join(", ");
                return parts;
            }).join("\n");
            sections.push(`## 本批消息参与者画像 (${relevantProfiles.length} 人)\n\n${profileLines}`);
        }

        // --- 核心事实（只取本批参与者的） ---
        if (relevantProfiles.length > 0) {
            const factLines: string[] = [];
            for (const p of relevantProfiles) {
                const result = this.memory!.listCoreFacts({ subject: p.userId, limit: 5 });
                for (const f of result.items) {
                    const source = f.sourceChatId
                        ? ` 来源: ${this.formatChatLabel(f.sourceChatId, f.sourceChatTitle)}`
                        : f.sourceChatTitle
                            ? ` 来源: ${f.sourceChatTitle}`
                            : "";
                    const topic = f.sourceTopicLabel ? ` / 话题: ${f.sourceTopicLabel}` : "";
                    const boundary = [f.visibility, f.sensitivity].filter(Boolean).join("/");
                    factLines.push(`- (${f.category}) ${this.formatUserLabel(f.subject)}: ${f.content}${source}${topic}${boundary ? ` (${boundary})` : ""}`);
                }
            }
            if (factLines.length > 0) {
                sections.push(`## 相关事实 (${factLines.length} 条)\n\n${factLines.join("\n")}`);
            }
        }

        return sections;
    }

    private formatUserLabel(userId: string): string {
        const identity = this.memory?.getPersonIdentity(userId);
        const name = identity?.displayName?.trim() || userId;
        return `${name}(${userId})`;
    }

    private formatChatLabel(chatId: string, fallbackTitle?: string | null): string {
        const model = this.memory?.getGroupModel(getGroupModelKey(chatId));
        const title = model?.chatTitle?.trim() || fallbackTitle?.trim() || chatId;
        return `${title}(${chatId})`;
    }

    private computeTopicAssociations(topic: Topic, chatId: string): {
        associatedMemories: import("../memory-v2/types.js").AssociatedMemory[];
        callbackPotential: number;
    } {
        if (!this.memory || topic.keywords.length === 0) {
            return { associatedMemories: [], callbackPotential: 0 };
        }

        const query = topic.keywords.join(" ");
        const facts = this.memory.searchFacts(query, { limit: 15 });
        const topics = this.memory.searchTopics(query, {
            chatId,
            limit: 10,
            excludeTopicIds: [topic.id],
        }).filter((candidate) => candidate.startedAt < new Date(topic.createdAt).toISOString());

        let score = 0;
        const anecdoteCount = facts.filter((fact) => fact.category === "anecdote").length;
        score += anecdoteCount * 15;
        score += (facts.length - anecdoteCount) * 5;
        for (const candidate of topics) {
            const overlap = candidate.participants.filter((participant) => topic.participantIds.has(participant)).length;
            score += overlap * 10;
        }
        score += topics.length * 5;

        return {
            associatedMemories: [
                ...facts.slice(0, 5).map((fact) => ({
                    type: "core_fact" as const,
                    factId: fact.factId,
                    subject: fact.subject,
                    subjectLabel: this.formatUserLabel(fact.subject),
                    category: fact.category,
                    content: fact.content,
                    confidence: fact.confidence,
                    sourceChatId: fact.sourceChatId,
                    sourceChatLabel: fact.sourceChatId
                        ? this.formatChatLabel(fact.sourceChatId, fact.sourceChatTitle)
                        : fact.sourceChatTitle ?? null,
                    sourceTopicLabel: fact.sourceTopicLabel,
                    visibility: fact.visibility,
                    sensitivity: fact.sensitivity,
                })),
                ...topics.slice(0, 3).map((candidate) => ({
                    type: "topic" as const,
                    topicId: candidate.topicId,
                    label: candidate.label,
                    summary: candidate.summary,
                    startedAt: candidate.startedAt,
                    endedAt: candidate.endedAt,
                })),
            ],
            callbackPotential: Math.min(score, 100),
        };
    }

    /**
     * Step 3: 更新 TopicRegistry
     */
    private updateRegistry(
        chatId: string,
        messages: Message[],
        clustering: TopicClusteringResult,
        triageResult: TopicSummaryTriageResult,
        formattedMessagesById?: Map<string, string>,
    ): {
        topics: Topic[];
        signalReadyTopics: Topic[];
        clusterIdMap: Map<string, string>;
        topicMessagesById: Map<string, Message[]>;
    } {
        const updatedTopics: Topic[] = [];
        const signalReadyTopics: Topic[] = [];
        // 映射: 真实话题ID → clustering 临时 ID（如 NEW_1），用于 Step 4 查找 triage 结果
        const clusterIdMap = new Map<string, string>();

        // 按话题分组消息
        const topicMsgMap = new Map<string, Message[]>();
        const topicMessagesById = new Map<string, Message[]>();
        for (const assignment of clustering.assignments) {
            const msg = messages.find(m => m.id === assignment.messageId);
            if (!msg) continue;
            const group = topicMsgMap.get(assignment.topicId) ?? [];
            group.push(msg);
            topicMsgMap.set(assignment.topicId, group);
        }

        for (const [topicId, topicMsgs] of topicMsgMap) {
            let topic: Topic | undefined;
            const contextLines = topicMsgs.map((msg) => this.formatTopicContextLine(msg, formattedMessagesById));

            // 尝试获取已有话题
            topic = this.registry.get(topicId);

            if (!topic) {
                // 当 ID 不存在于 registry 时，无论它是不是 "NEW_" 开头，都视为新话题（容错 LLM 乱编 ID）
                const assignment = clustering.assignments.find(a => a.topicId === topicId);
                const label = assignment?.topicLabel ?? topicId;
                const keywords = assignment?.keywords ?? [];

                // 检查是否是流变
                const evolution = clustering.evolutions.find(e => e.newTopicLabel === label);
                topic = this.registry.create(chatId, label, keywords, topicMsgs, evolution?.parentTopicId);
                this.applyEnrichedRecentContext(topic, contextLines, [], 5);
                clusterIdMap.set(topic.id, topicId); // topic.id=真实ID, topicId=临时ID

                if (evolution?.parentTopicId) {
                    this.registry.inheritDecision(evolution.parentTopicId, topic.id);
                }
            } else {
                // 已有话题，追加消息
                const existingContextLines = topic.recentContext ? topic.recentContext.split("\n") : [];
                this.registry.addMessages(topicId, topicMsgs);
                this.applyEnrichedRecentContext(topic, contextLines, existingContextLines, 8);
            }

            if (!topic) continue;

            const triage = triageResult.topics.find(t => t.topicId === topicId);
            log.info("updateRegistry: 话题处理", {
                topicId: topic.id,
                clusterTopicId: topicId,
                label: topic.label,
                state: topic.state,
                triageFound: !!triage,
                triageReason: triage?.reason,
                msgCount: topicMsgs.length,
            });
            if (triage) {
                // 缓存摘要信息到 Topic 对象，供下一轮 flush 时作为旧话题上下文
                topic.lastSummary = triage.summary;

                // 唯一的跳过条件：agent 已经回复过比这批消息更新的内容
                const latestMsgTs = Math.max(...topicMsgs.map(m => m.timestamp));
                const wasAlreadyRepliedByAgent = this.lastAgentReplyAt > 0
                    && latestMsgTs <= this.lastAgentReplyAt;

                if (wasAlreadyRepliedByAgent) {
                    const reason = `agent already replied at ${new Date(this.lastAgentReplyAt).toISOString()}, topic last msg at ${new Date(latestMsgTs).toISOString()}`;
                    log.info("话题跳过入队（已回复）", {
                        topicId: topic.id,
                        label: topic.label,
                        state: topic.state,
                        reason,
                    });
                    updatedTopics.push(topic);
                    topicMessagesById.set(topic.id, topicMsgs);
                    continue;
                }

                const decision = {
                    reason: triage.reason,
                };
                // 将 decision 持久化到 topic 对象，supply triageReason 给下游 toDigest
                this.registry.setDecision(topic.id, decision);
                if (triage.shouldSignal === true) {
                    signalReadyTopics.push(topic);
                }
            }

            topicMessagesById.set(topic.id, topicMsgs);
            updatedTopics.push(topic);
        }

        log.info("updateRegistry: 完成", {
            totalTopics: updatedTopics.length,
            signalReadyCount: signalReadyTopics.length,
            signalReadyTopicIds: signalReadyTopics.map((topic) => topic.id),
        });

        return { topics: updatedTopics, signalReadyTopics, clusterIdMap, topicMessagesById };
    }

    /**
     * 按 chatId 分组消息
     */
    private groupByChat(messages: Message[]): Map<string, Message[]> {
        const groups = new Map<string, Message[]>();
        for (const msg of messages) {
            const group = groups.get(msg.chatId) ?? [];
            group.push(msg);
            groups.set(msg.chatId, group);
        }
        return groups;
    }

    private publishSignals(
        chatId: string,
        signalReadyTopics: Topic[],
        topicMessagesById: Map<string, Message[]>,
    ): void {
        const signalEntries = buildTopicSignalEntries({
            chatId,
            topics: signalReadyTopics,
            topicMessagesById,
            profiles: this.memory?.getProfilesForChat(chatId) ?? [],
            stickinessLevel: this.getStickinessLevel(),
        });
        if (signalEntries.length === 0) {
            return;
        }
        this.publishTopicSignals?.(signalEntries);
        this.emit("topics:signaled", signalEntries);
    }

    /**
     * 直接添加消息到缓冲区（不触发定时器/自动 flush）
     *
     * 用于 dry-run 模式，由外部控制 flush 时机。
     */
    addMessageDirect(msg: Message): void {
        this.buffer.push(msg);
    }

    /**
     * 获取当前缓冲大小（调试用）
     */
    get bufferSize(): number {
        return this.buffer.length;
    }

    /**
     * 获取 Pipeline 当前状态（供 Dashboard 调用）
     */
    getStatus(): { bufferSize: number; isEagerMode: boolean; isFlushing: boolean; disposed: boolean } {
        return {
            bufferSize: this.buffer.length,
            isEagerMode: this.isEagerMode,
            isFlushing: this.isFlushing,
            disposed: this.disposed,
        };
    }

    /**
     * 停止 Pipeline
     */
    dispose(): void {
        this.disposed = true;
        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
            this.silenceTimer = null;
        }
    }
}
