import type { AttentionItem } from "./types.js";

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
