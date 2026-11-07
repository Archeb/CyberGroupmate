import type { StickinessLevel } from "../subagent/types.js";

export type AttentionLayer = 0 | 1 | 2;

export type AttentionSource =
    | "DIRECT_ADDRESS"
    | "CALLBACK"
    | "SCHEDULER"
    | "WAKE_CONDITION"
    | "TOPIC_SIGNAL"
    | "PROACTIVE_IDLE"
    | "BACKGROUND_AGENT";

export interface AttentionItem {
    layer: AttentionLayer;
    chatId: string;
    source: AttentionSource;
    payload: unknown;
    enqueuedAt: number;
    pressure?: number;
    ignoredCount?: number;
}

export interface AttentionSet {
    timestamp: number;
    items: AttentionItem[];
    triggerReason: "window" | "preempt";
}

export interface ReleasedAttentionRecord {
    item: AttentionItem;
    releasedAt: number;
}

export interface AttentionSnapshotItem extends AttentionItem {
    kind: "pending" | "signal";
    blocked: boolean;
}

export interface AttentionAccumulatorSnapshot {
    active: AttentionSnapshotItem[];
    dequeued: ReleasedAttentionRecord[];
    blockedChatIds: string[];
    /** chat 被 block 期间暂存、待 unblock 后投递的条目数 */
    parkedCountByChatId: Record<string, number>;
}

export interface PressureParticipant {
    messageCount: number;
    totalChars: number;
    dunbarTier: 1 | 2 | 3 | 4;
}

export interface PressureInput {
    participants: PressureParticipant[];
    stickinessLevel: StickinessLevel;
    ageMinutes: number;
    ignoredCount: number;
}

export interface DynamicSignalPressureInput {
    participants: PressureParticipant[];
    stickinessLevel: StickinessLevel;
}
