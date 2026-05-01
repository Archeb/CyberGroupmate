import type { AttentionQueueEntry } from "../subagent/types.js";
import type { AttentionItem } from "./types.js";

const STICKINESS_BONUS = {
    CORE: 25,
    FAMILIAR: 15,
    ACQUAINTANCE: 8,
    STRANGER: 0,
} as const;

export function estimateSignalPressureFromQueueEntry(entry: AttentionQueueEntry): number {
    const topicMessageCount = entry.topicDigests.reduce((sum, digest) => sum + digest.messageCount, 0);
    const callbackPotential = entry.callbackPotential ?? 0;
    const urgentBonus = (entry.urgentSignals?.length ?? 0) > 0 ? 20 : 0;

    return entry.priority
        + Math.min(topicMessageCount, 50)
        + callbackPotential
        + urgentBonus
        + STICKINESS_BONUS[entry.stickinessLevel];
}

export function createDirectAddressItem(
    chatId: string,
    payload: unknown,
    enqueuedAt: number = Date.now(),
): Omit<AttentionItem, "layer"> {
    return {
        chatId,
        source: "DIRECT_ADDRESS",
        payload,
        enqueuedAt,
    };
}

export function createSchedulerItem(
    chatId: string,
    payload: unknown,
    enqueuedAt: number = Date.now(),
): Omit<AttentionItem, "layer"> {
    return {
        chatId,
        source: "SCHEDULER",
        payload,
        enqueuedAt,
    };
}

export function queueEntryToTopicSignalItem(
    entry: AttentionQueueEntry,
): Omit<AttentionItem, "layer"> {
    return {
        chatId: entry.chatId,
        source: "TOPIC_SIGNAL",
        payload: {
            topicDigests: entry.topicDigests,
            snapshotTimestamp: entry.snapshotTimestamp,
            callbackPotential: entry.callbackPotential,
            queueSource: entry.source,
        },
        enqueuedAt: entry.enqueuedAt,
        pressure: estimateSignalPressureFromQueueEntry(entry),
    };
}