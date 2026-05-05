import type { PlatformAdapter } from "./platform-adapter.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("read-receipts");

export function markChatAsRead(
    adapters: readonly PlatformAdapter[],
    chatId: string,
    reason: string,
): void {
    const adapter = adapters.find((item) => chatId.startsWith(`${item.platform}:`));
    if (!adapter?.markAsRead) {
        return;
    }

    const handleError = (error: unknown) => {
        log.debug("markAsRead failed", {
            chatId,
            reason,
            error: String(error).slice(0, 100),
        });
    };

    try {
        adapter.markAsRead(chatId).catch(handleError);
    } catch (error) {
        handleError(error);
    }
}
