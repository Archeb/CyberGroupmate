import { GlobalState } from "../main-agent/global-state.js";
import { createLogger } from "../core/logger.js";
import type { SignalPoolItem } from "../subagent/types.js";
import type { AttentionItem, AttentionLayer, AttentionSet, AttentionSource } from "./types.js";

const log = createLogger("attention-accumulator");

function isAttentionSource(value: string): value is AttentionSource {
    return value === "DIRECT_ADDRESS"
        || value === "CALLBACK"
        || value === "SCHEDULER"
        || value === "WAKE_CONDITION"
        || value === "TOPIC_SIGNAL";
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

function compareAttentionItems(left: AttentionItem, right: AttentionItem): number {
    if (left.layer !== right.layer) return left.layer - right.layer;
    const leftPressure = left.pressure ?? 0;
    const rightPressure = right.pressure ?? 0;
    if (leftPressure !== rightPressure) return rightPressure - leftPressure;
    return left.enqueuedAt - right.enqueuedAt;
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
        const entry: AttentionItem = {
            ...item,
            layer,
            ignoredCount: item.ignoredCount ?? 0,
        };

        if (layer === 2) {
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

        const releasedSignals = [...this.signalPool]
            .sort(compareAttentionItems)
            .slice(0, this.topN);

        for (const signal of releasedSignals) {
            signal.ignoredCount = (signal.ignoredCount ?? 0) + 1;
        }

        const items = [...this.pending, ...releasedSignals]
            .sort(compareAttentionItems)
            .map(item => ({ ...item }));

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

    dispose(): void {
        this.persistSignalPool();
    }

    private persistSignalPool(): void {
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
}