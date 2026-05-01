import type { StickinessLevel } from "../subagent/types.js";

export type AttentionLayer = 0 | 1 | 2;

export type AttentionSource =
    | "DIRECT_ADDRESS"
    | "CALLBACK"
    | "SCHEDULER"
    | "WAKE_CONDITION"
    | "TOPIC_SIGNAL";

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