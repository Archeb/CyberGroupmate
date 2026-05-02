import { GlobalState } from "../main-agent/global-state.js";
import { createLogger } from "../core/logger.js";
import { calculatePressure } from "./pressure.js";
import type { SignalPoolItem } from "../subagent/types.js";
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
        || value === "PROACTIVE_IDLE";
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
    topN?: number;
}

export class AttentionAccumulator {
    private pending: AttentionItem[] = [];
    private signalPool: AttentionItem[] = [];
    private preempted = false;
    private windowStartedAt: number | null = null;
    private blockedChatIds = new Set<string>();
    private dequeueHistory: ReleasedAttentionRecord[] = [];
    private readonly maxDequeueHistory = 50;
    private readonly windowMs: number;
    private readonly topN: number;

    constructor(
        private readonly globalState: GlobalState,
        config?: AttentionAccumulatorConfig,
    ) {
        this.windowMs = config?.windowMs ?? 5_000;
        this.topN = config?.topN ?? 3;
    }

    restoreSignalPool(): void {
        this.signalPool = this.globalState.getSignalPool().map(toAttentionItem);
        log.info("restoreSignalPool", { count: this.signalPool.length });
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
            this.signalPool.push(entry);
            this.persistSignalPool();
            return;
        }

        this.pending.push(entry);
        if (this.windowStartedAt === null) {
            this.windowStartedAt = entry.enqueuedAt;
        }
        if (layer === 0) {
            this.preempted = true;
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
        if (item.layer === 0) {
            this.preempted = true;
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
            this.preempted = false;
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
            this.preempted = false;
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
            && !this.preempted
            && this.windowStartedAt !== null
            && now - this.windowStartedAt < this.windowMs
        ) {
            return null;
        }

        this.refreshSignalPoolPressures(now);
        const releasedSignals = [...this.signalPool]
            .sort(compareAttentionItemsAt(now))
            .slice(0, this.topN);

        for (const signal of releasedSignals) {
            signal.ignoredCount = (signal.ignoredCount ?? 0) + 1;
            signal.pressure = resolvePressure(signal, now);
        }

        const items = [...this.pending, ...releasedSignals]
            .sort(compareAttentionItemsAt(now))
            .map(cloneAttentionItem);

        for (const item of items) {
            this.pushDequeueHistory(item, now);
        }

        this.pending = [];
        this.preempted = false;
        this.windowStartedAt = null;
        this.persistSignalPool();

        return {
            timestamp: now,
            items,
            triggerReason: items.some(item => item.layer === 0) ? "preempt" : "window",
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
