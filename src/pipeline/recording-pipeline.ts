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
import { callLLM, type LLMConfig, type ChatMessage } from "../core/llm.js";
import { renderPrompt } from "../main-agent/prompt-renderer.js";
import type { MemoryStoreV2 } from "../memory-v2/index.js";
import { embed } from "../memory-v2/embedding.js";
import type { EmbeddingConfig } from "../core/config.js";
import type { TopicRegistry } from "./topic-registry.js";
import { getRawId, getGroupModelKey } from "../core/chat-id.js";
import type {
    Message,
    TopicClusteringResult,
    TopicSummaryTriageResult,
    Topic,
    TriageDecision,
} from "./types.js";
import type { RecordingPipelineConfig } from "../core/config.js";

const log = createLogger("recording-pipeline");

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
 * RecordingPipeline — 后台消息观察者
 *
 * Events:
 * - `flush:start` (messageCount: number)
 * - `flush:complete` (topics: Topic[])
 * - `flush:error` (error: Error)
 * - `topics:triage-passed` (triagePassedTopics: Array<{ topic: Topic, decision: TriageDecision }>)
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

    constructor(
        private registry: TopicRegistry,
        private llmConfig: LLMConfig,
        private personaName: string = "赛博群友",
        private personaDescription: string = "赛博群友",
        private memory?: MemoryStoreV2,
        private embeddingConfig?: EmbeddingConfig,
        pipelineConfig?: RecordingPipelineConfig,
    ) {
        super();
        this.minFlushSize = pipelineConfig?.minFlushSize ?? DEFAULT_MIN_FLUSH_SIZE;
        this.normalThreshold = pipelineConfig?.normalThreshold ?? DEFAULT_NORMAL_THRESHOLD;
        this.eagerThreshold = pipelineConfig?.eagerThreshold ?? DEFAULT_EAGER_THRESHOLD;
        this.normalSilence = pipelineConfig?.normalSilenceMs ?? DEFAULT_NORMAL_SILENCE;
        this.eagerSilence = pipelineConfig?.eagerSilenceMs ?? DEFAULT_EAGER_SILENCE;
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
        const messages = [...this.buffer];
        this.buffer = [];
        this.isEagerMode = false;  // 每次 flush 后重置
        const clusterOnly = options?.clusterOnly ?? false;

        log.info("flush 开始", { messageCount: messages.length, clusterOnly });
        this.emit("flush:start", messages.length);

        try {
            // ─── Step 1: 话题聚类 ───
            const groupedByChat = this.groupByChat(messages);

            for (const [chatId, chatMessages] of groupedByChat) {
                const existingTopics = this.registry.getByChat(chatId);

                const clustering = await this.llmTopicClustering(chatMessages, existingTopics);

                // ─── Step 2: 摘要 + Triage（clusterOnly 模式跳过）───
                const triageResult = clusterOnly
                    ? { topics: [] } as TopicSummaryTriageResult
                    : await this.llmTopicSummaryTriage(chatMessages, clustering, chatId);

                // ─── Step 3: 更新 TopicRegistry ───
                const { topics: updatedTopics, clusterIdMap } = this.updateRegistry(chatId, chatMessages, clustering, triageResult);

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
                            participants: [...topic.participantIds].map(String),
                            messageRange: {
                                messageIds: topic.messageIds,
                                count: topic.messageCount,
                            },
                            startedAt: new Date(topic.createdAt).toISOString(),
                        });
                    }

                    // 批量写入原始消息到 message_log
                    this.memory.storeMessageBatch(chatMessages.map(m => ({
                        messageId: m.id,
                        chatId: String(m.chatId),
                        userId: String(m.senderId),
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
                            this.memory.upsertPersonIdentity(String(m.senderId), {
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
                        this.memory.incrementProfileStats(String(uid), String(chatId), {
                            messageCountDelta: s.count,
                            activeHoursDelta: s.hours,
                            lastSeenAt: s.lastTs,
                        });
                    }

                    // M4.5: 生成 topic embedding
                    if (this.embeddingConfig) {
                        try {
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
                                const embeddings = await embed(
                                    summaries.map(s => s.text),
                                    this.embeddingConfig,
                                );
                                for (let i = 0; i < summaries.length; i++) {
                                    this.memory.upsertTopic(summaries[i].id, {
                                        embedding: embeddings[i],
                                    });
                                }
                                log.debug("Pipeline Step 4: embedding 生成完成", { count: summaries.length });
                            }
                        } catch (err) {
                            log.warn("Pipeline Step 4: embedding 生成失败", { error: String(err) });
                        }
                    }

                    log.debug("Memory V2 写入完成", {
                        topicCount: updatedTopics.length,
                        messageCount: chatMessages.length,
                        userCount: seenUsers.size,
                    });
                } else {
                    log.debug("Memory V2 写入（无 memory 实例，跳过）", { topicCount: updatedTopics.length });
                }

                this.emit("flush:complete", updatedTopics);
            }
        } catch (err) {
            log.error("flush 失败", { error: err instanceof Error ? err.message : String(err) });
            this.emit("flush:error", err);
            // 把消息放回缓冲头部，避免丢失
            this.buffer.unshift(...messages);
        } finally {
            this.isFlushing = false;
        }
    }

    /**
     * Step 1: LLM 话题聚类
     */
    private async llmTopicClustering(
        messages: Message[],
        existingTopics: Topic[]
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

        const messagesStr = messages.map(m =>
            `[${m.id}] ${m.senderName} (${new Date(m.timestamp).toLocaleTimeString()}): ${m.text}`
        ).join("\n");

        const prompt = renderPrompt("TOPIC_CLUSTERING", {
            existingTopics: existingTopicsStr,
            messages: messagesStr,
        });

        const llmMessages: ChatMessage[] = [
            { role: "system", content: "你是一个话题聚类助手。只输出合法 JSON，不要任何其他内容。" },
            { role: "user", content: prompt },
        ];

        const response = await callLLM(llmMessages, this.llmConfig, { caller: "recording-pipeline" });

        try {
            // 提取 JSON（处理可能的 markdown 包裹）
            const jsonStr = response.content
                .replace(/```json\s*/g, "")
                .replace(/```\s*/g, "")
                .trim();
            return JSON.parse(jsonStr) as TopicClusteringResult;
        } catch {
            log.warn("话题聚类 LLM 输出解析失败，使用默认归类", { raw: response.content.slice(0, 200) });
            // 回退：所有消息归为一个新话题
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
    }

    /**
     * Step 2: LLM 话题摘要 + Triage
     */
    private async llmTopicSummaryTriage(
        messages: Message[],
        clustering: TopicClusteringResult,
        chatId: string
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
        const topicMessagesStr = this.buildTopicContextStr(allTopicIds, topicGroups, clustering);

        const prompt = renderPrompt("TOPIC_TRIAGE", {
            personaName: this.personaName,
            persona: this.personaDescription,
        });

        // 构建富化的 user message：群组信息 + 参与者画像 + 话题上下文
        const contextSections: string[] = [];
        contextSections.push(...this.buildTriageContext(chatId, messages));
        contextSections.push(topicMessagesStr);
        const userMessage = contextSections.join("\n\n");

        const llmMessages: ChatMessage[] = [
            { role: "system", content: prompt },
            { role: "user", content: userMessage },
        ];

        const response = await callLLM(llmMessages, this.llmConfig, { caller: "recording-pipeline" });

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
            const retryStr = this.buildTopicContextStr(missingIds, topicGroups, clustering);
            const retryPrompt = renderPrompt("TOPIC_TRIAGE", {
                personaName: this.personaName,
                persona: this.personaDescription,
            });

            const retryMessages: ChatMessage[] = [
                { role: "system", content: retryPrompt },
                { role: "user", content: retryStr },
            ];

            try {
                const retryResponse = await callLLM(retryMessages, this.llmConfig, { caller: "recording-pipeline" });
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

    /**
     * 构建话题上下文字符串（供 Step 2 prompt 使用）
     *
     * 对旧话题：附带 label、上一轮 summary/reason、recentContext 历史消息
     * 对新话题：只含本批次消息
     */
    private buildTopicContextStr(
        topicIds: string[],
        topicGroups: Map<string, Message[]>,
        clustering: TopicClusteringResult
    ): string {
        return topicIds.map(topicId => {
            const msgs = topicGroups.get(topicId) ?? [];
            const newMsgLines = msgs.map(m => `  ${m.senderName}: ${m.text}`).join("\n");

            if (topicId.startsWith("NEW_")) {
                // 新话题：用 clustering 里的 label
                const label = clustering.assignments.find(a => a.topicId === topicId)?.topicLabel ?? "新话题";
                return `### 话题: ${label} (ID: ${topicId})\n${newMsgLines}`;
            }

            // 旧话题：从 registry 取完整上下文
            const topic = this.registry.get(topicId);
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
                const namePart = identity?.displayName
                    ? ` (显示名: ${identity.displayName}` +
                    (identity.username ? `, @${identity.username}` : "") +
                    `)`
                    : "";
                const parts = [
                    `- **${getRawId(p.userId)}**${namePart}`,
                    `Tier ${p.dunbarTier}`,
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
                    factLines.push(`- (${f.category}) ${getRawId(f.subject)}: ${f.content}`);
                }
            }
            if (factLines.length > 0) {
                sections.push(`## 相关事实 (${factLines.length} 条)\n\n${factLines.join("\n")}`);
            }
        }

        return sections;
    }

    /**
     * Step 3: 更新 TopicRegistry
     */
    private updateRegistry(
        chatId: string,
        messages: Message[],
        clustering: TopicClusteringResult,
        triageResult: TopicSummaryTriageResult
    ): { topics: Topic[]; clusterIdMap: Map<string, string> } {
        const updatedTopics: Topic[] = [];
        // 收集本次 flush 通过 triage 的话题，在循环结束后批量 emit
        const triagePassedTopics: Array<{ topic: Topic; decision: TriageDecision }> = [];
        // 映射: 真实话题ID → clustering 临时 ID（如 NEW_1），用于 Step 4 查找 triage 结果
        const clusterIdMap = new Map<string, string>();

        // 按话题分组消息
        const topicMsgMap = new Map<string, Message[]>();
        for (const assignment of clustering.assignments) {
            const msg = messages.find(m => m.id === assignment.messageId);
            if (!msg) continue;
            const group = topicMsgMap.get(assignment.topicId) ?? [];
            group.push(msg);
            topicMsgMap.set(assignment.topicId, group);
        }

        for (const [topicId, topicMsgs] of topicMsgMap) {
            let topic: Topic | undefined;

            if (topicId.startsWith("NEW_")) {
                // 新话题
                const assignment = clustering.assignments.find(a => a.topicId === topicId);
                const label = assignment?.topicLabel ?? "未命名话题";
                const keywords = assignment?.keywords ?? [];

                // 检查是否是流变
                const evolution = clustering.evolutions.find(e => e.newTopicLabel === label);
                topic = this.registry.create(chatId, label, keywords, topicMsgs, evolution?.parentTopicId);
                clusterIdMap.set(topic.id, topicId); // topic.id=真实ID, topicId=NEW_x

                if (evolution?.parentTopicId) {
                    this.registry.inheritDecision(evolution.parentTopicId, topic.id);
                }
            } else {
                // 已有话题
                topic = this.registry.get(topicId);
                if (topic) {
                    this.registry.addMessages(topicId, topicMsgs);
                }
            }

            if (!topic) continue;

            // 只对 ACTIVE 状态的话题应用 Triage（已 IGNORED/ENGAGED 的不重复 triage）
            if (topic.state !== "ACTIVE") {
                log.debug("跳过已决策话题", { topicId: topic.id, state: topic.state, label: topic.label });
                updatedTopics.push(topic);
                continue;
            }

            const triage = triageResult.topics.find(t => t.topicId === topicId);
            if (triage) {
                // 缓存摘要信息到 Topic 对象，供下一轮 flush 时作为旧话题上下文
                topic.lastSummary = triage.summary;

                const wasAlreadyHandledByFastPath = topicMsgs.some(msg => msg._viaFastPath);

                // 时间戳防重复：如果话题的所有消息都在 agent 上次回复之前，
                // 说明 agent 已通过其他路径（alert→CodeAct/FastPath）回复过，不再重复介入
                const latestMsgTs = Math.max(...topicMsgs.map(m => m.timestamp));
                const wasAlreadyRepliedByAgent = this.lastAgentReplyAt > 0
                    && latestMsgTs <= this.lastAgentReplyAt;

                if (wasAlreadyHandledByFastPath || wasAlreadyRepliedByAgent) {
                    const reason = wasAlreadyHandledByFastPath
                        ? "already handled via fast path"
                        : `agent already replied at ${new Date(this.lastAgentReplyAt).toISOString()}, topic last msg at ${new Date(latestMsgTs).toISOString()}`;
                    log.info("话题跳过 triage（已回复）", {
                        topicId: topic.id,
                        label: topic.label,
                        reason,
                        lastAgentReplyAt: this.lastAgentReplyAt,
                        latestMsgTs,
                    });
                    const decision: TriageDecision = {
                        should_intervene: false,
                        reason,
                    };

                    this.registry.transition(topic.id, "TRIAGING");
                    this.registry.setDecision(topic.id, decision);
                    topic.ignoreReason = decision.reason;
                    this.registry.transition(topic.id, "IGNORED");
                    updatedTopics.push(topic);
                    continue;
                }

                const decision: TriageDecision = {
                    should_intervene: triage.should_intervene,
                    reason: triage.reason,
                };

                this.registry.transition(topic.id, "TRIAGING");

                if (triage.should_intervene) {
                    this.registry.setDecision(topic.id, decision);
                    this.registry.transition(topic.id, "PRELOADING");
                    this.registry.transition(topic.id, "ENGAGED");
                    triagePassedTopics.push({ topic, decision });
                } else {
                    this.registry.setDecision(topic.id, decision);
                    topic.ignoreReason = triage.reason;
                    this.registry.transition(topic.id, "IGNORED");
                }
            }

            updatedTopics.push(topic);
        }

        // 批量 emit triage-passed 事件（一次 flush 只触发一次入队）
        if (triagePassedTopics.length > 0) {
            this.emit("topics:triage-passed", triagePassedTopics);
        }

        return { topics: updatedTopics, clusterIdMap };
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
