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
import type { MemoryStoreV2 } from "../memory-v2/index.js";
import { embed } from "../memory-v2/embedding.js";
import type { EmbeddingConfig } from "../core/config.js";
import type { TopicRegistry } from "./topic-registry.js";
import type {
    Message,
    TopicClusteringResult,
    TopicSummaryTriageResult,
    Topic,
    TriageDecision,
} from "./types.js";

const log = createLogger("recording-pipeline");

// ─── 常量 ───

/** 正常缓冲阈值（条数） */
const NORMAL_THRESHOLD = 50;

/** 加速缓冲阈值（条数） */
const EAGER_THRESHOLD = 15;

/** 正常静默触发（毫秒） */
const NORMAL_SILENCE = 2 * 60 * 1000;  // 2 min

/** 加速静默触发（毫秒） */
const EAGER_SILENCE = 30 * 1000;       // 30 sec

// ─── Prompt 模板 ───

const TOPIC_CLUSTERING_PROMPT = `你是一个消息话题分析器。
请分析以下消息，将每条消息归属到一个话题中。

已有话题列表（如果有的话）：
{EXISTING_TOPICS}

新消息列表：
{MESSAGES}

请输出 JSON 格式：
{
  "assignments": [
    { "messageId": "<字符串消息ID>", "topicId": "<已有话题ID或NEW_1/NEW_2等>", "topicLabel": "<仅新话题>", "keywords": ["<仅新话题>"] }
  ],
  "evolutions": [
    { "parentTopicId": "<父话题ID>", "newTopicLabel": "<新话题标签>", "reason": "<演变原因>" }
  ]
}

规则：
- 如果消息属于已有话题，直接用已有话题 ID
- 不是每一条消息都必定属于一个话题，如果某消息相对孤立，与当前上下文无关、之前也没出现过，请直接跳过。
- 如果是全新话题，用 NEW_1, NEW_2 等临时 ID，并提供 topicLabel 和 keywords
- 如果话题从已有话题演变而来（内容明显偏移但有关联），在 evolutions 中记录
- topicLabel 应为 3-5 个词，概括话题主旨
- 只输出 JSON，不要其他内容`;

const TOPIC_TRIAGE_PROMPT = `你是一个AI 智能体的决策顾问。
请分析每个话题，判断 AI 智能体是否应该介入。

AI 智能体人设：{PERSONA}

话题列表及其消息：
{TOPIC_MESSAGES}

请输出 JSON 格式：
{
  "topics": [
    {
      "topicId": "<话题ID>",
      "summary": "<2-3句话摘要，和标题不重复>",
      "keyPoints": ["<要点1>", "<要点2>"],
      "should_intervene": true/false,
      "intervention_type": "FACTUAL_CORRECTION|KNOWLEDGE_GAP|QUESTION_ANSWER|RESOURCE_SHARING|CONFLICT_MEDIATION|CONSENSUS_SUMMARY|CASUAL_CHAT|NOT_APPLICABLE",
      "confidence": 0.0-1.0,
      "reason": "<判断理由>"
    }
  ]
}

判断标准：
- confidence < 0.6 一律不介入
- 优先介入：有人提问无人回答、事实性错误、群友求助
- 谨慎介入：闲聊、八卦、争吵
- 不介入：私密对话、敏感话题、已有专业人士在解答
- 注意：群里可能有多个 AI 智能体或者 Bot，看清楚话题是否与人设中描述的那个智能体一致
- 只输出 JSON，不要其他内容`;

/**
 * RecordingPipeline — 后台消息观察者
 *
 * Events:
 * - `flush:start` (messageCount: number)
 * - `flush:complete` (topics: Topic[])
 * - `flush:error` (error: Error)
 * - `topic:triage-passed` (topic: Topic, decision: TriageDecision)
 */
export class RecordingPipeline extends EventEmitter {
    private buffer: Message[] = [];
    private isEagerMode = false;
    private silenceTimer: ReturnType<typeof setTimeout> | null = null;
    private isFlushing = false;
    private disposed = false;

    /** Agent 最后回复时间戳（由 GroupSubagent 同步写入），用于 triage 防重复 */
    lastAgentReplyAt: number = 0;

    constructor(
        private registry: TopicRegistry,
        private llmConfig: LLMConfig,
        private personaDescription: string = "赛博群友",
        private memory?: MemoryStoreV2,
        private embeddingConfig?: EmbeddingConfig,
    ) {
        super();
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
        const threshold = this.isEagerMode ? EAGER_THRESHOLD : NORMAL_THRESHOLD;
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
        const silence = this.isEagerMode ? EAGER_SILENCE : NORMAL_SILENCE;
        this.silenceTimer = setTimeout(() => {
            this.triggerFlush();
        }, silence);
    }

    /**
     * 触发 flush
     */
    private triggerFlush(): void {
        if (this.isFlushing || this.buffer.length === 0) return;
        // 使用 void 忽略 Promise 返回值
        void this.flush();
    }

    /**
     * 核心 flush 流程（4 步）
     */
    async flush(): Promise<void> {
        if (this.isFlushing || this.buffer.length === 0) return;

        this.isFlushing = true;
        const messages = [...this.buffer];
        this.buffer = [];
        this.isEagerMode = false;  // 每次 flush 后重置

        log.info("flush 开始", { messageCount: messages.length });
        this.emit("flush:start", messages.length);

        try {
            // ─── Step 1: 话题聚类 ───
            const groupedByChat = this.groupByChat(messages);

            for (const [chatId, chatMessages] of groupedByChat) {
                const existingTopics = this.registry.getByChat(chatId);

                const clustering = await this.llmTopicClustering(chatMessages, existingTopics);

                // ─── Step 2: 摘要 + Triage ───
                const triageResult = await this.llmTopicSummaryTriage(chatMessages, clustering, chatId);

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
                            // 仅在有 triage 结果时写入 summary/keyPoints，避免后续 flush 覆写已有数据
                            ...(triage?.summary ? { summary: triage.summary } : {}),
                            ...(triage?.keyPoints?.length ? { keyPoints: triage.keyPoints } : {}),
                            keywords: topic.keywords,
                            participants: [...topic.participantIds].map(String),
                            messageRange: {
                                messageIds: topic.messageIds,
                                count: topic.messageCount,
                            },
                            startedAt: new Date(topic.createdAt).toISOString(),
                            wasEngaged: topic.state === "ENGAGED" || topic.interventionCount > 0,
                            interventionCount: topic.interventionCount,
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

        const prompt = TOPIC_CLUSTERING_PROMPT
            .replace("{EXISTING_TOPICS}", existingTopicsStr)
            .replace("{MESSAGES}", messagesStr);

        const llmMessages: ChatMessage[] = [
            { role: "system", content: "你是一个精确的 JSON 输出助手。只输出合法 JSON，不要任何其他内容。" },
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

        const prompt = TOPIC_TRIAGE_PROMPT
            .replace("{PERSONA}", this.personaDescription)
            .replace("{TOPIC_MESSAGES}", topicMessagesStr);

        const llmMessages: ChatMessage[] = [
            { role: "system", content: "你是一个精确的 JSON 输出助手。只输出合法 JSON，不要任何其他内容。" },
            { role: "user", content: prompt },
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
            const retryPrompt = TOPIC_TRIAGE_PROMPT
                .replace("{PERSONA}", this.personaDescription)
                .replace("{TOPIC_MESSAGES}", retryStr);

            const retryMessages: ChatMessage[] = [
                { role: "system", content: "你是一个精确的 JSON 输出助手。只输出合法 JSON，不要任何其他内容。" },
                { role: "user", content: retryPrompt },
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
     * 对旧话题：附带 label、上一轮 summary/keyPoints/reason、recentContext 历史消息
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
            if (topic?.lastKeyPoints?.length) {
                parts.push(`  上一轮要点: ${topic.lastKeyPoints.join("; ")}`);
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
     * Step 3: 更新 TopicRegistry
     */
    private updateRegistry(
        chatId: string,
        messages: Message[],
        clustering: TopicClusteringResult,
        triageResult: TopicSummaryTriageResult
    ): { topics: Topic[]; clusterIdMap: Map<string, string> } {
        const updatedTopics: Topic[] = [];
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
                topic.lastKeyPoints = triage.keyPoints;

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
                        intervention_type: "NOT_APPLICABLE",
                        confidence: 1.0,
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
                    intervention_type: triage.intervention_type,
                    confidence: triage.confidence,
                };

                // 冷却增强：提高置信度阈值
                const threshold = topic.cooldownBoost ? 0.75 : 0.6;

                this.registry.transition(topic.id, "TRIAGING");

                if (triage.should_intervene && triage.confidence >= threshold) {
                    this.registry.setDecision(topic.id, decision);
                    this.registry.transition(topic.id, "PRELOADING");
                    this.registry.transition(topic.id, "ENGAGED");
                    this.emit("topic:triage-passed", topic, decision);
                } else {
                    this.registry.setDecision(topic.id, decision);
                    const ignoreState = triage.confidence < 0.3
                        ? "IGNORED_LOW_VALUE" as const
                        : "IGNORED" as const;
                    topic.ignoreReason = triage.reason;
                    this.registry.transition(topic.id, ignoreState);
                }
            }

            updatedTopics.push(topic);
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
