import type { PlatformAdapter } from "./platform-adapter.js";

export function createTypingSender(adapter: PlatformAdapter | undefined): ((chatId: string) => Promise<void>) | undefined {
    if (!adapter) return undefined;
    const method = `${adapter.platform}.sendTyping`;
    if (!adapter.canHandle(method)) return undefined;
    return async (chatId: string): Promise<void> => {
        await adapter.handleCall(method, [chatId]);
    };
}
