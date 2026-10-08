/**
 * backfill.ts — 离线补抓协调器
 *
 * 解决的问题：进程重启或平台掉线期间别人发的消息，adapter 收不到事件，
 * 于是既不落盘也不唤醒 agent —— agent 永远不知道自己收到过消息。
 *
 * 设计要点：
 * 1. 水位线来自 message_log（主键 (chat_id, message_id) + INSERT OR IGNORE），
 *    所以补抓天然幂等，不需要额外持久化状态，也不怕崩溃。
 * 2. 补抓的消息带 `_backfill: true` 标记走正常的 NC 管线：过滤、落盘、
 *    Observer、RecordingPipeline 都复用，但**不逐条唤醒** ——
 *    否则几百条历史消息会逐条触发 attend，并对几小时前的消息逐条回复。
 * 3. 离线期间若有 DM / @ 提及，为该会话产生**一次**合并唤醒，
 *    reason 标为 offline-backfill，让 agent 知道这是补看的旧消息。
 * 4. 普通群消息不做特殊唤醒：喂给 RecordingPipeline 后，
 *    话题聚类 → topic signal 的既有链路会自然决定要不要接话。
 */

import { createLogger } from "../core/logger.js";
import { loadConfig, type BackfillConfig } from "../core/config.js";
import type { NotificationCenter } from "../event/notification-center.js";
import type { PlatformAdapter, BackfillResult } from "./platform-adapter.js";

const log = createLogger("backfill");

/** 补抓消息在 NC 事件上的标记字段 */
export const BACKFILL_FLAG = "_backfill";
/**
 * "过旧/过量"的补抓消息标记。
 *
 * 带此标记的消息仍然落盘（不丢数据），但跳过 RecordingPipeline ——
 * 话题聚类和 triage 都要调 LLM，离线三天回来几千条消息会直接把成本打爆。
 */
export const BACKFILL_STALE_FLAG = "_backfillStale";
/** 合并唤醒时使用的 directReason */
export const BACKFILL_DIRECT_REASON = "offline-backfill";

export const DEFAULT_BACKFILL: Required<BackfillConfig> = {
    enabled: true,
    maxMessagesPerChat: 50,
    maxChats: 20,
    maxAgeMinutes: 720,
    delayMs: 3000,
    downloadMedia: false,
};

/**
 * 收敛 notes：只保留前若干条 + 省略计数。
 * 会话多的时候逐条报错会把单行日志刷成几千字符。
 */
export function summarizeBackfillNotes(notes: string[], keep = 5): string[] | undefined {
    if (notes.length === 0) return undefined;
    if (notes.length <= keep) return notes;
    return [...notes.slice(0, keep), `...（另有 ${notes.length - keep} 条同类错误已省略）`];
}

export function resolveBackfillConfig(config?: BackfillConfig): Required<BackfillConfig> {
    if (!config) return { ...DEFAULT_BACKFILL };
    return {
        enabled: config.enabled ?? DEFAULT_BACKFILL.enabled,
        maxMessagesPerChat: config.maxMessagesPerChat ?? DEFAULT_BACKFILL.maxMessagesPerChat,
        maxChats: config.maxChats ?? DEFAULT_BACKFILL.maxChats,
        maxAgeMinutes: config.maxAgeMinutes ?? DEFAULT_BACKFILL.maxAgeMinutes,
        delayMs: config.delayMs ?? DEFAULT_BACKFILL.delayMs,
        downloadMedia: config.downloadMedia ?? DEFAULT_BACKFILL.downloadMedia,
    };
}

/** 补抓期间累积的、需要合并唤醒的会话 */
interface PendingWake {
    chatId: string;
    messageCount: number;
    directCount: number;
    earliestTs: string;
    latestTs: string;
    reasons: Set<string>;
}

export interface BackfillCoordinatorDeps {
    nc: NotificationCenter;
    adapters: PlatformAdapter[];
    /** 查询会话水位线 */
    getWatermark(chatId: string, ordering: "numeric-id" | "timestamp"): { messageId: string; timestamp: string } | null;
    /** 列出某平台本地已知的会话 */
    listKnownChatIds(platformPrefix: string): string[];
    /** 合并唤醒回调：该会话在离线期间收到过需要回应的消息 */
    onConsolidatedWake(chatId: string, summary: BackfillWakeSummary): void;
    getConfig?: () => BackfillConfig | undefined;
}

export interface BackfillWakeSummary {
    chatId: string;
    /** 补抓到的消息总数 */
    messageCount: number;
    /** 其中属于直接提及（DM / @ / 回复 agent）的条数 */
    directCount: number;
    /** 补抓消息的时间范围 */
    earliestTs: string;
    latestTs: string;
    /** 触发原因（DM / @mention 等） */
    reasons: string[];
}

/** 各平台 message id 是否单调递增（决定水位线取法） */
const ID_ORDERING: Record<string, "numeric-id" | "timestamp"> = {
    telegram: "numeric-id",
    discord: "numeric-id",
    onebot: "timestamp",
    feishu: "timestamp",
};

/**
 * 补抓消息安静多久之后做合并唤醒。
 *
 * telegram 的 catch-up 由 mtcute 异步派发，不受 run() 控制，
 * 所以唤醒不能只在 run() 结束时触发，需要一个"安静窗口"兜住。
 */
const WAKE_FLUSH_DEBOUNCE_MS = 5000;

/**
 * 同一平台两次「自动」补抓之间的最小间隔。
 *
 * 防自激循环：补抓用到的平台 API 本身可能弄崩连接（实测 NapCat 的
 * get_group_msg_history 对某个群会超时并带崩 ws），连接恢复又会触发补抓，
 * 于是无限循环。手动触发和启动时的首次补抓不受此限制。
 */
const MIN_AUTO_RUN_INTERVAL_MS = 10 * 60_000;

export class BackfillCoordinator {
    private readonly pendingWakes = new Map<string, PendingWake>();
    private running = false;
    private lastRunAt = 0;
    private flushTimer: NodeJS.Timeout | null = null;
    /** 每个平台上次补抓时间（自动触发的节流依据） */
    private readonly lastRunByPlatform = new Map<string, number>();

    constructor(private readonly deps: BackfillCoordinatorDeps) {}

    private config(): Required<BackfillConfig> {
        const raw = this.deps.getConfig?.() ?? loadConfig().backfill;
        return resolveBackfillConfig(raw);
    }

    get isRunning(): boolean {
        return this.running;
    }

    get lastRunTimestamp(): number {
        return this.lastRunAt;
    }

    /**
     * 记录一条补抓消息（由 NC 管线在识别到 `_backfill` 标记时调用）。
     * 只累积统计，唤醒统一在 flushWakes() 里做。
     */
    noteBackfilledMessage(chatId: string, options: {
        timestamp: string;
        directReason?: string;
    }): void {
        const existing = this.pendingWakes.get(chatId);
        const entry: PendingWake = existing ?? {
            chatId,
            messageCount: 0,
            directCount: 0,
            earliestTs: options.timestamp,
            latestTs: options.timestamp,
            reasons: new Set<string>(),
        };

        entry.messageCount++;
        if (options.directReason) {
            entry.directCount++;
            entry.reasons.add(options.directReason);
        }
        if (options.timestamp && options.timestamp < entry.earliestTs) entry.earliestTs = options.timestamp;
        if (options.timestamp && options.timestamp > entry.latestTs) entry.latestTs = options.timestamp;

        this.pendingWakes.set(chatId, entry);
        this.armFlushTimer();
    }

    /** 消息安静 WAKE_FLUSH_DEBOUNCE_MS 后自动合并唤醒（覆盖 telegram catch-up 这类异步路径） */
    private armFlushTimer(): void {
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            // run() 进行中就再等一轮，避免把同一批补抓拆成多次唤醒
            if (this.running) {
                this.armFlushTimer();
                return;
            }
            this.flushWakes();
        }, WAKE_FLUSH_DEBOUNCE_MS);
        if (this.flushTimer.unref) this.flushTimer.unref();
    }

    /** 停止待处理的定时器（进程收尾用） */
    dispose(): void {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
    }

    /**
     * 把累积的补抓结果转成合并唤醒。
     *
     * 只有存在直接提及（DM / @ / 回复 agent）的会话才强制唤醒；
     * 普通群消息交给话题信号链路自然处理，避免补抓变成刷屏式打扰。
     */
    flushWakes(): BackfillWakeSummary[] {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.pendingWakes.size === 0) return [];

        const summaries: BackfillWakeSummary[] = [];
        for (const entry of this.pendingWakes.values()) {
            const summary: BackfillWakeSummary = {
                chatId: entry.chatId,
                messageCount: entry.messageCount,
                directCount: entry.directCount,
                earliestTs: entry.earliestTs,
                latestTs: entry.latestTs,
                reasons: [...entry.reasons],
            };
            summaries.push(summary);

            if (entry.directCount > 0) {
                try {
                    this.deps.onConsolidatedWake(entry.chatId, summary);
                } catch (err) {
                    log.warn("补抓合并唤醒失败", { chatId: entry.chatId, error: String(err) });
                }
            }
        }

        this.pendingWakes.clear();
        log.info("补抓合并唤醒完成", {
            chats: summaries.length,
            woken: summaries.filter((s) => s.directCount > 0).length,
            messages: summaries.reduce((sum, s) => sum + s.messageCount, 0),
        });
        return summaries;
    }

    /**
     * 对所有支持补抓的 adapter 执行一次补抓。
     *
     * @param platforms 只补抓这些平台；不传则全部
     */
    async run(
        platforms?: string[],
        options?: { force?: boolean },
    ): Promise<{ results: Record<string, BackfillResult>; wakes: BackfillWakeSummary[] }> {
        const config = this.config();
        if (!config.enabled) {
            log.debug("补抓已禁用，跳过");
            return { results: {}, wakes: [] };
        }
        if (this.running) {
            log.info("补抓已在进行中，跳过本次触发");
            return { results: {}, wakes: [] };
        }

        this.running = true;
        const results: Record<string, BackfillResult> = {};
        const since = new Date(Date.now() - config.maxAgeMinutes * 60_000);

        try {
            for (const adapter of this.deps.adapters) {
                if (platforms && !platforms.includes(adapter.platform)) continue;
                if (typeof adapter.fetchMissedMessages !== "function") continue;

                const state = adapter.getConnectionStatus?.().state;
                if (state && state !== "connected") {
                    log.info("跳过未连接的 adapter", { platform: adapter.platform, state });
                    continue;
                }

                // 自动触发的补抓要遵守最小间隔，避免"补抓弄崩连接 → 重连 → 再补抓"的自激循环
                if (!options?.force) {
                    const lastRun = this.lastRunByPlatform.get(adapter.platform) ?? 0;
                    const elapsed = Date.now() - lastRun;
                    if (lastRun > 0 && elapsed < MIN_AUTO_RUN_INTERVAL_MS) {
                        log.info("距上次补抓过近，跳过本次自动触发", {
                            platform: adapter.platform,
                            elapsedMs: elapsed,
                            minIntervalMs: MIN_AUTO_RUN_INTERVAL_MS,
                        });
                        continue;
                    }
                }
                this.lastRunByPlatform.set(adapter.platform, Date.now());

                const ordering = ID_ORDERING[adapter.platform] ?? "timestamp";
                let delivered = 0;

                try {
                    const result = await adapter.fetchMissedMessages({
                        maxMessagesPerChat: config.maxMessagesPerChat,
                        maxChats: config.maxChats,
                        since,
                        knownChatIds: this.deps.listKnownChatIds(adapter.platform),
                        getWatermark: (chatId) => this.deps.getWatermark(chatId, ordering),
                        deliver: (event) => {
                            delivered++;
                            this.deps.nc.push({
                                ...event,
                                [BACKFILL_FLAG]: true,
                            } as never);
                        },
                    });
                    results[adapter.platform] = result;
                    log.info("平台补抓完成", {
                        platform: adapter.platform,
                        chats: result.chats,
                        messages: result.messages,
                        delivered,
                        notes: result.notes,
                    });
                } catch (err) {
                    log.warn("平台补抓失败", { platform: adapter.platform, error: String(err) });
                    results[adapter.platform] = { chats: 0, messages: delivered, notes: [String(err)] };
                }
            }
        } finally {
            this.running = false;
            this.lastRunAt = Date.now();
        }

        return { results, wakes: this.flushWakes() };
    }
}

/**
 * 判断一批候选消息里哪些是水位线之后的新消息。
 *
 * numeric-id：按数值比较（telegram 会话内递增、discord snowflake）。
 * timestamp：按时间比较（onebot message_id 不保证有序）。
 * 两种模式都额外用 since 兜住"第一次运行没有水位线"的情况。
 */
export function isNewerThanWatermark(
    candidate: { messageId: string; timestamp: string },
    watermark: { messageId: string; timestamp: string } | null,
    ordering: "numeric-id" | "timestamp",
    since: Date,
): boolean {
    const candidateTime = Date.parse(candidate.timestamp);
    if (Number.isFinite(candidateTime) && candidateTime < since.getTime()) return false;

    if (!watermark) return true;

    if (ordering === "numeric-id") {
        // snowflake 超过 2^53，必须用 BigInt 比较
        try {
            return BigInt(candidate.messageId) > BigInt(watermark.messageId);
        } catch {
            // 非数字 id，退回时间比较
        }
    }

    const watermarkTime = Date.parse(watermark.timestamp);
    if (!Number.isFinite(candidateTime) || !Number.isFinite(watermarkTime)) return true;
    return candidateTime > watermarkTime;
}
