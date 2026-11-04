import { GlobalState } from "../main-agent/global-state.js";
import { createLogger } from "../core/logger.js";
import { calculatePressure } from "./pressure.js";
import type { SignalPoolItem } from "../subagent/types.js";
import type { TopicSignalPayload } from "../pipeline/topic-signal.js";
import type {
    AttentionAccumulatorSnapshot,
    AttentionItem,
    AttentionLayer,
    AttentionSet,
    AttentionSnapshotItem,
    AttentionSource,
    DynamicSignalPressureInput,
    ReleasedAttentionRecord,
} from "./types.js";

const log = createLogger("attention-accumulator");

function isAttentionSource(value: string): value is AttentionSource {
    return value === "DIRECT_ADDRESS"
        || value === "CALLBACK"
        || value === "SCHEDULER"
        || value === "WAKE_CONDITION"
        || value === "TOPIC_SIGNAL"
        || value === "PROACTIVE_IDLE"
        || value === "BACKGROUND_AGENT";
}

function toAttentionItem(item: SignalPoolItem): AttentionItem {
    return {
        layer: 2,
        chatId: item.chatId,
        source: isAttentionSource(item.source) ? item.source : "TOPIC_SIGNAL",
        payload: item.payload,
        enqueuedAt: item.enqueuedAt,
        pressure: item.pressure,
        ignoredCount: item.ignoredCount,
    };
}

function hasDynamicPressureInput(payload: unknown): payload is { pressureInput: DynamicSignalPressureInput } {
    if (!payload || typeof payload !== "object") return false;
    const maybePressureInput = (payload as { pressureInput?: DynamicSignalPressureInput }).pressureInput;
    return !!maybePressureInput
        && Array.isArray(maybePressureInput.participants)
        && typeof maybePressureInput.stickinessLevel === "string";
}

function resolvePressure(item: AttentionItem, now: number): number {
    if (!hasDynamicPressureInput(item.payload)) {
        return item.pressure ?? 0;
    }

    return calculatePressure({
        participants: item.payload.pressureInput.participants,
        stickinessLevel: item.payload.pressureInput.stickinessLevel,
        ageMinutes: Math.max(0, (now - item.enqueuedAt) / 60_000),
        ignoredCount: item.ignoredCount ?? 0,
    });
}

function getTopicSignalPayload(item: AttentionItem): TopicSignalPayload | null {
    if (item.layer !== 2 || item.source !== "TOPIC_SIGNAL") return null;
    const payload = item.payload as Partial<TopicSignalPayload> | undefined;
    const digest = payload?.topicDigest;
    const pressureInput = payload?.pressureInput;
    if (!digest || typeof digest.topicId !== "string") return null;
    if (!pressureInput || !Array.isArray(pressureInput.participants)) return null;
    return payload as TopicSignalPayload;
}

function topicSignalKey(item: AttentionItem): string | null {
    const payload = getTopicSignalPayload(item);
    return payload ? `${item.chatId}::${payload.topicDigest.topicId}` : null;
}

/**
 * 合并同群同话题的重复信号。
 *
 * recording pipeline 的连续 flush 窗口是重叠的，因此不能把 messageCount / totalChars 相加，
 * 否则会把同一批消息重复计入压力。这里只做三类合并：
 * - 描述性字段取最新 digest；
 * - 计数/潜力取较强值，参与者/关键词取并集；
 * - 等待时间取最早的一次，压力用更强的那份 pressureInput 重新计算。
 */
function mergeTopicSignal(existing: AttentionItem, incoming: AttentionItem, now: number): boolean {
    const oldPayload = getTopicSignalPayload(existing);
    const newPayload = getTopicSignalPayload(incoming);
    if (!oldPayload || !newPayload) return false;
    if (existing.chatId !== incoming.chatId) return false;
    if (oldPayload.topicDigest.topicId !== newPayload.topicDigest.topicId) return false;

    const oldDigest = oldPayload.topicDigest;
    const newDigest = newPayload.topicDigest;
    const mergedDigest: TopicSignalPayload["topicDigest"] = {
        ...newDigest,
        messageCount: Math.max(oldDigest.messageCount ?? 0, newDigest.messageCount ?? 0),
        callbackPotential: Math.max(oldDigest.callbackPotential ?? 0, newDigest.callbackPotential ?? 0),
        participants: [...new Set([...(oldDigest.participants ?? []), ...(newDigest.participants ?? [])])],
        keywords: [...new Set([...(oldDigest.keywords ?? []), ...(newDigest.keywords ?? [])])],
    };

    const oldPressure = resolvePressure(existing, now);
    const newPressure = resolvePressure(incoming, now);
    const strongerInput = newPressure >= oldPressure
        ? newPayload.pressureInput
        : oldPayload.pressureInput;

    existing.enqueuedAt = Math.min(existing.enqueuedAt, incoming.enqueuedAt);
    existing.ignoredCount = Math.max(existing.ignoredCount ?? 0, incoming.ignoredCount ?? 0);
    existing.payload = { topicDigest: mergedDigest, pressureInput: strongerInput };
    existing.pressure = calculatePressure({
        participants: strongerInput.participants,
        stickinessLevel: strongerInput.stickinessLevel,
        ageMinutes: Math.max(0, (now - existing.enqueuedAt) / 60_000),
        ignoredCount: existing.ignoredCount,
    });
    return true;
}

function compareAttentionItemsAt(now: number) {
    return (left: AttentionItem, right: AttentionItem): number => {
    if (left.layer !== right.layer) return left.layer - right.layer;
    const leftPressure = resolvePressure(left, now);
    const rightPressure = resolvePressure(right, now);
    if (leftPressure !== rightPressure) return rightPressure - leftPressure;
    return left.enqueuedAt - right.enqueuedAt;
    };
}

function cloneAttentionItem(item: AttentionItem): AttentionItem {
    return {
        ...item,
        payload: item.payload,
    };
}

export interface AttentionAccumulatorConfig {
    windowMs?: number;
    /** Maximum attention items released per flush window. */
    topN?: number;
}

export class AttentionAccumulator {
    private pending: AttentionItem[] = [];
    private signalPool: AttentionItem[] = [];
    private windowStartedAt: number | null = null;
    private blockedChatIds = new Set<string>();
    private dequeueHistory: ReleasedAttentionRecord[] = [];
    private readonly maxDequeueHistory = 50;
    private readonly windowMs: number;
    private readonly maxWindowItems: number;

    constructor(
        private readonly globalState: GlobalState,
        config?: AttentionAccumulatorConfig,
    ) {
        this.windowMs = config?.windowMs ?? 5_000;
        this.maxWindowItems = config?.topN ?? 3;
    }

    restoreSignalPool(): void {
        const restored = this.globalState.getSignalPool().map(toAttentionItem);
        const merged: AttentionItem[] = [];
        const byKey = new Map<string, AttentionItem>();
        const now = Date.now();

        for (const item of restored) {
            const key = topicSignalKey(item);
            if (key) {
                const existing = byKey.get(key);
                if (existing) {
                    mergeTopicSignal(existing, item, now);
                    continue;
                }
                byKey.set(key, item);
            }
            merged.push(item);
        }

        this.signalPool = merged;
        log.info("restoreSignalPool", {
            count: this.signalPool.length,
            restored: restored.length,
            mergedDuplicates: restored.length - this.signalPool.length,
        });
        if (merged.length !== restored.length) {
            this.persistSignalPool();
        }
    }

    ingest(layer: AttentionLayer, item: Omit<AttentionItem, "layer">): void {
        if (this.blockedChatIds.has(item.chatId)) {
            log.debug("ingest: ignored blocked chat", { chatId: item.chatId, layer, source: item.source });
            return;
        }

        const entry: AttentionItem = {
            ...item,
            layer,
            ignoredCount: item.ignoredCount ?? 0,
        };

        if (layer === 2) {
            entry.pressure = resolvePressure(entry, entry.enqueuedAt);
            const key = topicSignalKey(entry);
            const existing = key
                ? this.signalPool.find((item) => topicSignalKey(item) === key)
                : undefined;
            if (existing && mergeTopicSignal(existing, entry, Date.now())) {
                this.persistSignalPool();
                log.debug("ingest: merged duplicate topic signal", {
                    chatId: entry.chatId,
                    topicId: getTopicSignalPayload(entry)?.topicDigest.topicId,
                    pressure: existing.pressure,
                });
                return;
            }
            this.signalPool.push(entry);
            this.persistSignalPool();
            return;
        }

        this.pending.push(entry);
        if (this.windowStartedAt === null) {
            this.windowStartedAt = entry.enqueuedAt;
        }
    }

    requeue(item: AttentionItem): void {
        if (item.layer === 2 || this.blockedChatIds.has(item.chatId)) {
            return;
        }

        this.pending.push(cloneAttentionItem(item));
        if (this.windowStartedAt === null) {
            this.windowStartedAt = item.enqueuedAt;
        } else {
            this.windowStartedAt = Math.min(this.windowStartedAt, item.enqueuedAt);
        }
    }

    block(chatId: string): void {
        this.blockedChatIds.add(chatId);
        const pendingBefore = this.pending.length;
        const signalBefore = this.signalPool.length;

        this.pending = this.pending.filter((item) => item.chatId !== chatId);
        this.signalPool = this.signalPool.filter((item) => item.chatId !== chatId);
        if (this.pending.length === 0) {
            this.windowStartedAt = null;
        }
        if (this.signalPool.length !== signalBefore) {
            this.persistSignalPool();
        }

        log.debug("block", {
            chatId,
            removedPending: pendingBefore - this.pending.length,
            removedSignals: signalBefore - this.signalPool.length,
        });
    }

    unblock(chatId: string): void {
        this.blockedChatIds.delete(chatId);
    }

    isBlocked(chatId: string): boolean {
        return this.blockedChatIds.has(chatId);
    }

    remove(chatId: string): void {
        this.blockedChatIds.delete(chatId);
        this.pending = this.pending.filter((item) => item.chatId !== chatId);
        const signalBefore = this.signalPool.length;
        this.signalPool = this.signalPool.filter((item) => item.chatId !== chatId);
        if (this.pending.length === 0) {
            this.windowStartedAt = null;
        }
        if (this.signalPool.length !== signalBefore) {
            this.persistSignalPool();
        }
    }

    flush(now: number = Date.now()): AttentionSet | null {
        if (this.pending.length === 0 && this.signalPool.length === 0) {
            return null;
        }

        if (
            this.pending.length > 0
            && this.windowStartedAt !== null
            && now - this.windowStartedAt < this.windowMs
        ) {
            return null;
        }

        this.refreshSignalPoolPressures(now);
        const releasedPending = [...this.pending]
            .sort(compareAttentionItemsAt(now))
            .slice(0, this.maxWindowItems);
        const remainingSlots = Math.max(0, this.maxWindowItems - releasedPending.length);
        const releasedSignals = remainingSlots > 0
            ? [...this.signalPool]
                .sort(compareAttentionItemsAt(now))
                .slice(0, remainingSlots)
            : [];

        for (const signal of releasedSignals) {
            signal.ignoredCount = (signal.ignoredCount ?? 0) + 1;
            signal.pressure = resolvePressure(signal, now);
        }

        const items = [...releasedPending, ...releasedSignals]
            .sort(compareAttentionItemsAt(now))
            .map(cloneAttentionItem);

        for (const item of items) {
            this.pushDequeueHistory(item, now);
        }

        const releasedPendingSet = new Set(releasedPending);
        const releasedSignalSet = new Set(releasedSignals);
        this.pending = this.pending.filter((item) => !releasedPendingSet.has(item));
        this.signalPool = this.signalPool.filter((item) => !releasedSignalSet.has(item));
        this.windowStartedAt = this.pending.length > 0 ? now : null;
        this.persistSignalPool();

        return {
            timestamp: now,
            items,
            triggerReason: "window",
        };
    }

    markActioned(chatId: string): void {
        let changed = false;
        for (const signal of this.signalPool) {
            if (signal.chatId !== chatId) continue;
            if ((signal.ignoredCount ?? 0) !== 0) {
                signal.ignoredCount = 0;
                signal.pressure = resolvePressure(signal, Date.now());
                changed = true;
            }
        }
        if (changed) {
            this.persistSignalPool();
        }
    }

    getSignalPoolSize(): number {
        return this.signalPool.length;
    }

    getActiveCount(): number {
        return this.pending.length + this.signalPool.length;
    }

    getBlockedCount(): number {
        return this.blockedChatIds.size;
    }

    getSnapshot(): AttentionAccumulatorSnapshot {
        this.refreshSignalPoolPressures(Date.now());
        const active: AttentionSnapshotItem[] = [
            ...this.pending.map((item) => ({
                ...cloneAttentionItem(item),
                kind: "pending" as const,
                blocked: false,
            })),
            ...this.signalPool.map((item) => ({
                ...cloneAttentionItem(item),
                kind: "signal" as const,
                blocked: false,
            })),
        ].sort(compareSnapshotItems);

        return {
            active,
            dequeued: this.dequeueHistory.map((record) => ({
                item: cloneAttentionItem(record.item),
                releasedAt: record.releasedAt,
            })),
            blockedChatIds: [...this.blockedChatIds].sort(),
        };
    }

    dispose(): void {
        this.persistSignalPool();
    }

    private pushDequeueHistory(item: AttentionItem, releasedAt: number): void {
        this.dequeueHistory.push({
            item: cloneAttentionItem(item),
            releasedAt,
        });
        if (this.dequeueHistory.length > this.maxDequeueHistory) {
            this.dequeueHistory.shift();
        }
    }

    private persistSignalPool(): void {
        this.refreshSignalPoolPressures(Date.now());
        this.globalState.setSignalPool(
            this.signalPool.map((item) => ({
                chatId: item.chatId,
                source: item.source,
                payload: item.payload,
                enqueuedAt: item.enqueuedAt,
                pressure: item.pressure ?? 0,
                ignoredCount: item.ignoredCount ?? 0,
            }))
        );
    }

    private refreshSignalPoolPressures(now: number): void {
        for (const signal of this.signalPool) {
            signal.pressure = resolvePressure(signal, now);
        }
    }
}

function compareSnapshotItems(left: AttentionSnapshotItem, right: AttentionSnapshotItem): number {
    return compareAttentionItemsAt(Date.now())(left, right);
}
