/**
 * phase6/dry-run.ts — Dry-Run 历史回放评估系统
 *
 * 在历史聊天记录上离线模拟 agent 行为，用于评估和调优决策流水线。
 *
 * 工作方式：
 * 1. 从 JSON 文件加载历史消息
 * 2. 按时间顺序模拟事件到达
 * 3. 每条消息经过 FastRouter + RecordingPipeline + Triage
 * 4. Recording Pipeline flush 时写入 Memory V2（topics / message_log / person_identities）
 * 5. 可选：处理完后触发 Reflection（反思总结）
 * 6. 输出 JSON 评估报告 + Memory 统计
 */

import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { createLogger } from "../core/logger.js";
import { resolveTierProfile, resolveEmbeddingConfig, type AppConfig, type LLMConfig } from "../core/config.js";
import { TopicRegistry } from "./topic-registry.js";
import { RecordingPipeline } from "./recording-pipeline.js";
import { EngagedTopicHandler } from "./engaged-topic-handler.js";
import { FastRouter } from "./fast-router.js";
import { ModelRouter } from "./model-router.js";
import { MemoryStoreV2 } from "../memory-v2/index.js";
import type {
    Message,
    DryRunConfig,
    DryRunResult,
    DryRunDecision,
} from "./types.js";

const log = createLogger("dry-run");

/** 历史消息文件格式（每行一个 JSON 对象） */
interface HistoryMessage {
    id: string | number;
    chat_id: string | number;
    user_id: string | number;
    user_name: string;
    text: string;
    date: string;          // ISO 8601
    reply_to?: string | number;
}

/**
 * 规范化 Telegram chat_id。
 * Telegram 的超级群/频道 chat_id 应该是负数（-100xxxxxxxxxx）。
 * 但从 Desktop 导出的 JSON 中，chat_id 可能是正数。
 * 这里做规范化，确保群组/频道 ID 是负数。
 *
 * 判断逻辑：如果 chat_id > 0 且位数 >= 10，很可能是超级群 ID，需要取反。
 * Telegram 用户 ID 通常 < 10亿（10位数跨界），而超级群 ID 通常都是 10 位以上。
 */
function normalizeChatId(chatId: string | number): string {
    const raw = String(chatId);
    const asNumber = Number(raw);
    if (!Number.isNaN(asNumber) && asNumber > 0 && asNumber > 1_000_000_000) {
        // 很可能是超级群/频道 ID，需要取反
        return String(-asNumber);
    }
    return raw;
}

/**
 * 运行 Dry-Run 评估
 */
export async function runDryRun(
    config: DryRunConfig,
    appConfig: AppConfig,
    persona: string = "赛博群友",
    agentUserId: string = "",
): Promise<DryRunResult> {
    const startTime = Date.now();
    log.info("Dry-Run 开始", {
        chatId: config.chatId,
        model: config.model,
        reflect: config.reflect ?? false,
    });

    // ─── 加载历史消息 ───
    const messages = loadHistoryMessages(config);

    if (messages.length === 0) {
        log.warn("没有找到历史消息");
        return {
            totalMessages: 0,
            wouldReply: 0,
            wouldIgnore: 0,
            decisions: [],
            totalTokens: 0,
            totalTimeMs: Date.now() - startTime,
        };
    }

    // ─── 初始化组件（按 tier 解析 profile）───
    const cheapConfig = resolveTierProfile("cheap", appConfig);
    const midConfig = resolveTierProfile("mid", appConfig);
    const sotaConfig = resolveTierProfile("sota", appConfig);
    const embeddingConfig = resolveEmbeddingConfig(appConfig);

    // ─── 创建 Memory V2 数据库 ───
    const dbPath = config.memoryDbPath ?? "workspace/dry-run-memory.db";
    // 删除旧的 dry-run DB（每次重新生成）
    if (existsSync(dbPath)) {
        try { unlinkSync(dbPath); } catch (e) { log.warn("旧 DB 删除失败（可能被占用）", { path: dbPath, error: String(e) }); }
        try { unlinkSync(dbPath + "-wal"); } catch { /* ok */ }
        try { unlinkSync(dbPath + "-shm"); } catch { /* ok */ }
    }
    const memory = new MemoryStoreV2(dbPath, { embeddingConfig });
    log.info("Memory V2 数据库已创建", { dbPath });

    const registry = new TopicRegistry();
    const recordingPipeline = new RecordingPipeline(registry, cheapConfig, persona, memory, embeddingConfig);
    const engagedHandler = new EngagedTopicHandler(registry, midConfig);
    const fastRouter = new FastRouter(registry, engagedHandler, recordingPipeline, agentUserId);
    const modelRouter = new ModelRouter(midConfig, undefined, {
        cheap: cheapConfig.model,
        mid: midConfig.model,
        sota: sotaConfig.model,
    });

    // 注册 topic:archived 事件 → 标记话题结束（与 main.ts 一致）
    registry.on("topic:archived", (topic: { id: string }) => {
        memory.finalizeTopic(topic.id);
        log.debug("话题归档 → finalizeTopic", { topicId: topic.id });
    });

    log.info("模型配置", {
        cheap: `${cheapConfig.model} (${appConfig.modelTiers.cheap})`,
        mid: `${midConfig.model} (${appConfig.modelTiers.mid})`,
        sota: `${sotaConfig.model} (${appConfig.modelTiers.sota})`,
        embedding: `${embeddingConfig.provider} (dim=${embeddingConfig.dimensions})`,
    });

    const decisions: DryRunDecision[] = [];
    let totalTokens = 0;

    // ─── 路由统计 ───
    const routeStats = {
        fast_path_mention: 0,
        fast_path_reply: 0,
        fast_path_private: 0,
        fast_path_command: 0,
        engaged: 0,
        recording: 0,
    };

    // 收集 triage 通过的话题
    recordingPipeline.on("topic:triage-passed", (topic, decision) => {
        const route = modelRouter.route(false, decision, []);
        log.info("🎯 话题通过 Triage", {
            topicId: topic.id,
            label: topic.label,
            intervention: decision.intervention_type,
            confidence: decision.confidence,
            reason: decision.reason,
        });
        decisions.push({
            triggerMessage: {
                from: "topic",
                text: `话题 "${topic.label}" 通过 Triage`,
                time: new Date(topic.lastActivityAt).toISOString(),
            },
            decision: "reply",
            reason: decision.reason,
            pipelineTrace: [
                `intervention_type=${decision.intervention_type}`,
                `confidence=${decision.confidence}`,
                `model=${route.model}`,
            ],
        });
    });

    // 监听 flush 事件
    recordingPipeline.on("flush:start", (count: number) => {
        log.info("📦 Recording flush 开始", { messageCount: count });
    });
    recordingPipeline.on("flush:complete", (topics: any[]) => {
        log.info("📦 Recording flush 完成", { topicCount: topics.length });
    });
    recordingPipeline.on("flush:error", (err: Error) => {
        log.error("📦 Recording flush 失败", { error: err.message });
    });

    // ─── 按时间顺序模拟消息到达 ───
    log.info("开始模拟", { totalMessages: messages.length });

    // 分批处理，每批最多 50 条
    const BATCH_SIZE = 50;
    let processedCount = 0;
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
        const batch = messages.slice(i, i + BATCH_SIZE);

        for (const msg of batch) {
            processedCount++;
            // 模拟消息到达
            const fastPathResults = fastRouter.routeMessage(msg);

            if (fastPathResults.type === "FAST_PATH") {
                // 统计 FAST_PATH 原因
                const reason = fastPathResults.reason;
                if (reason === "direct_mention") routeStats.fast_path_mention++;
                else if (reason === "reply_to_agent") routeStats.fast_path_reply++;
                else if (reason === "private_chat") routeStats.fast_path_private++;
                else routeStats.fast_path_command++;

                decisions.push({
                    triggerMessage: {
                        from: msg.senderName,
                        text: msg.text.slice(0, 200),
                        time: new Date(msg.timestamp).toISOString(),
                    },
                    decision: "reply",
                    reason: `FAST_PATH: ${reason}`,
                    pipelineTrace: ["FAST_PATH", reason],
                });
            } else if (fastPathResults.type === "ENGAGED") {
                routeStats.engaged++;
                // ENGAGED 消息不直接记录 decision，由 topic handler 处理
            } else {
                routeStats.recording++;
                // 直接添加到缓冲区（不触发自动 flush，由下方显式 flush 控制）
                recordingPipeline.addMessageDirect(msg);
            }
        }

        // 每批结束后强制 flush
        await recordingPipeline.flush();

        // 清理超时话题
        registry.cleanup();

        // 进度报告（每 1000 条）
        if (processedCount % 1000 === 0 || processedCount === messages.length) {
            log.info("进度", {
                processed: processedCount,
                total: messages.length,
                pct: (processedCount / messages.length * 100).toFixed(1) + "%",
                routeStats: { ...routeStats },
                topics: registry.size,
                buffer: recordingPipeline.bufferSize,
            });
        }
    }

    // 最终 flush
    await recordingPipeline.flush();

    // ─── Memory 统计 ───
    let memoryStats: DryRunResult["memoryStats"];
    try {
        const db = (memory as any).db;
        memoryStats = {
            topics: (db.prepare("SELECT COUNT(*) as cnt FROM topics").get() as any)?.cnt ?? 0,
            facts: (db.prepare("SELECT COUNT(*) as cnt FROM core_facts").get() as any)?.cnt ?? 0,
            messages: (db.prepare("SELECT COUNT(*) as cnt FROM message_log").get() as any)?.cnt ?? 0,
            persons: (db.prepare("SELECT COUNT(*) as cnt FROM person_identities").get() as any)?.cnt ?? 0,
            profiles: (db.prepare("SELECT COUNT(*) as cnt FROM person_group_profiles").get() as any)?.cnt ?? 0,
            dbPath,
        };
        log.info("📊 Memory V2 统计", memoryStats);
    } catch (err) {
        log.warn("无法读取 memory 统计", { error: String(err) });
    }

    // ─── 可选 Reflection ───
    let reflectionResults: DryRunResult["reflectionResults"];
    if (config.reflect) {
        log.info("🧠 开始 Reflection...");
        reflectionResults = [];

        // 收集所有出现过的 chatId
        const chatIds = new Set(messages.map(m => String(m.chatId)));

        for (const chatId of chatIds) {
            try {
                // 确保 group_model 存在（Reflection 需要它）
                memory.upsertGroupModel(chatId, { chatTitle: `Chat ${chatId}` });

                const result = await memory.reflect(chatId, cheapConfig, appConfig.reflection);
                reflectionResults.push({
                    chatId,
                    topicsSummary: result.topicsSummary.length,
                    personUpdates: result.personUpdates.length,
                    newFacts: result.newCoreFacts.length,
                    mergedEpisodes: result.mergedEpisodes,
                    insights: result.insights,
                });
                log.info("🧠 Reflection 完成", {
                    chatId,
                    topics: result.topicsSummary.length,
                    persons: result.personUpdates.length,
                    facts: result.newCoreFacts.length,
                    insights: result.insights.slice(0, 100),
                });
            } catch (err) {
                log.error("🧠 Reflection 失败", { chatId, error: String(err) });
            }
        }

        // 更新 memory 统计（Reflection 可能新增了 facts / profiles）
        try {
            const db = (memory as any).db;
            memoryStats = {
                topics: (db.prepare("SELECT COUNT(*) as cnt FROM topics").get() as any)?.cnt ?? 0,
                facts: (db.prepare("SELECT COUNT(*) as cnt FROM core_facts").get() as any)?.cnt ?? 0,
                messages: (db.prepare("SELECT COUNT(*) as cnt FROM message_log").get() as any)?.cnt ?? 0,
                persons: (db.prepare("SELECT COUNT(*) as cnt FROM person_identities").get() as any)?.cnt ?? 0,
                profiles: (db.prepare("SELECT COUNT(*) as cnt FROM person_group_profiles").get() as any)?.cnt ?? 0,
                dbPath,
            };
            log.info("📊 Reflection 后 Memory 统计", memoryStats);
        } catch { /* ignore */ }
    }

    // ─── 生成报告 ───
    const totalTimeMs = Date.now() - startTime;
    const result: DryRunResult = {
        totalMessages: messages.length,
        wouldReply: decisions.filter(d => d.decision === "reply").length,
        wouldIgnore: messages.length - decisions.filter(d => d.decision === "reply").length,
        decisions,
        totalTokens,
        totalTimeMs,
        memoryStats,
        reflectionResults,
    };

    log.info("Dry-Run 完成", {
        totalMessages: result.totalMessages,
        wouldReply: result.wouldReply,
        wouldIgnore: result.wouldIgnore,
        timeMs: totalTimeMs,
    });

    // 路由统计
    log.info("📊 路由统计", routeStats);
    log.info("📊 话题注册表最终状态", {
        totalTopics: registry.size,
        allTopics: registry.getAll().map(t => ({
            id: t.id,
            label: t.label,
            state: t.state,
            msgCount: t.messageCount,
            decision: t.decision ? {
                intervene: t.decision.should_intervene,
                type: t.decision.intervention_type,
                confidence: t.decision.confidence,
            } : null,
        })),
    });

    // 清理
    recordingPipeline.dispose();
    engagedHandler.dispose();
    memory.close();

    return result;
}

/**
 * 加载历史消息
 */
function loadHistoryMessages(config: DryRunConfig): Message[] {
    if (config.source === "file" && config.filePath) {
        if (!existsSync(config.filePath)) {
            log.error("历史消息文件不存在", { path: config.filePath });
            return [];
        }

        try {
            const raw = readFileSync(config.filePath, "utf-8");
            const lines = raw.split("\n").filter(l => l.trim());
            const messages: Message[] = [];

            for (const line of lines) {
                try {
                    const hist = JSON.parse(line) as HistoryMessage;
                    if (config.chatId && String(hist.chat_id) !== config.chatId) continue;
                    const normalizedChatId = normalizeChatId(hist.chat_id);
                    messages.push({
                        id: String(hist.id),
                        chatId: normalizedChatId,
                        senderId: String(hist.user_id),
                        senderName: hist.user_name,
                        text: hist.text,
                        replyToMessageId: hist.reply_to !== undefined ? String(hist.reply_to) : undefined,
                        timestamp: new Date(hist.date).getTime(),
                    });
                } catch {
                    // 跳过无效行
                }
            }

            // 按时间排序
            messages.sort((a, b) => a.timestamp - b.timestamp);

            // 按天数过滤
            if (config.daysBack > 0) {
                const cutoff = Date.now() - config.daysBack * 24 * 60 * 60 * 1000;
                return messages.filter(m => m.timestamp >= cutoff);
            }

            return messages;
        } catch (err) {
            log.error("加载历史消息文件失败", { error: err instanceof Error ? err.message : String(err) });
            return [];
        }
    }

    log.warn("不支持的消息来源", { source: config.source });
    return [];
}

/**
 * 将 Dry-Run 结果输出到文件
 */
export function saveDryRunReport(result: DryRunResult, outputPath: string): void {
    const report = {
        ...result,
        generatedAt: new Date().toISOString(),
        summary: {
            totalMessages: result.totalMessages,
            wouldReply: result.wouldReply,
            wouldIgnore: result.wouldIgnore,
            replyRate: result.totalMessages > 0
                ? (result.wouldReply / result.totalMessages * 100).toFixed(1) + "%"
                : "N/A",
            totalTimeMs: result.totalTimeMs,
        },
    };

    writeFileSync(outputPath, JSON.stringify(report, null, 2));
    log.info("报告已保存", { path: outputPath });
}
