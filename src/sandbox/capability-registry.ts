export interface CapabilityRegistryEnv {
    ctx: Record<string, unknown>;
    emitOutput: (line: string) => void;
    notifyHost: (event: Record<string, unknown>) => void;
    requestInput: (prompt: string) => Promise<string>;
    printToHost: (message: string) => void;
    spawnTask: (name: string, fn: (signal: AbortSignal) => Promise<void>) => void;
    killTask: (name: string) => void;
    listTasks: () => string[];
    callHost: (method: string, args?: unknown[]) => Promise<unknown>;
}

interface CapabilityRegistration {
    key: string;
    install: (env: CapabilityRegistryEnv) => unknown;
}

function hydrateTelegramMessage(message: unknown): unknown {
    if (!message || typeof message !== "object") return message;
    const raw = message as Record<string, unknown>;
    return {
        ...raw,
        date: raw.date ? new Date(String(raw.date)) : new Date(),
        replyToMessage: raw.replyToMessage && typeof raw.replyToMessage === "object"
            ? { ...(raw.replyToMessage as Record<string, unknown>) }
            : raw.replyToMessage,
    };
}

function formatTelegramAck(prefix: string, payload: unknown): string {
    if (!payload || typeof payload !== "object") return prefix;
    const raw = payload as Record<string, unknown>;
    const chat = raw.chat && typeof raw.chat === "object" ? raw.chat as Record<string, unknown> : undefined;
    const chatId = chat?.id ?? raw.chatId;
    const msgId = raw.id ?? raw.messageId;
    const text = typeof raw.text === "string" ? raw.text : undefined;
    const parts = [prefix];
    if (chatId !== undefined) parts.push(`chat=${String(chatId)}`);
    if (msgId !== undefined) parts.push(`msg=${String(msgId)}`);
    if (text) parts.push(`text=${text}`);
    return parts.join(" ");
}

function createTelegramClientProxy(env: CapabilityRegistryEnv) {
    return {
        getMe: async () => env.callHost("telegram.getMe", []),
        sendText: async (chatId: number | string, text: string, opts?: { replyTo?: number }) => {
            const sent = hydrateTelegramMessage(await env.callHost("telegram.sendText", [chatId, text, opts]));
            env.emitOutput(formatTelegramAck("[Telegram] sendText ok", sent));
            // 发射 agent_message_sent 通知，供 SentMessageCollector 捕获
            env.notifyHost({
                type: "system.agent_message_sent",
                scene: "telegram",
                chatId: String(chatId),
                messageId: typeof sent === "object" && sent && "id" in sent ? (sent as { id?: unknown }).id : undefined,
                text,
                replyToMessageId: opts?.replyTo,
                timestamp: new Date().toISOString(),
            });
            return sent;
        },
        sendMedia: async (chatId: number | string, media: unknown, opts?: { replyTo?: number; caption?: string }) => {
            const sent = hydrateTelegramMessage(await env.callHost("telegram.sendMedia", [chatId, media, opts]));
            env.emitOutput(formatTelegramAck("[Telegram] sendMedia ok", sent));
            // 发射 agent_message_sent 通知
            env.notifyHost({
                type: "system.agent_message_sent",
                scene: "telegram",
                chatId: String(chatId),
                messageId: typeof sent === "object" && sent && "id" in sent ? (sent as { id?: unknown }).id : undefined,
                text: opts?.caption ?? "[media]",
                timestamp: new Date().toISOString(),
            });
            return sent;
        },
        getChat: async (chatId: number | string) =>
            env.callHost("telegram.getChat", [chatId]),
        getUser: async (userId: number | string) =>
            env.callHost("telegram.getUser", [userId]),
        getChatMembers: async (chatId: number | string, opts?: { limit?: number }) =>
            env.callHost("telegram.getChatMembers", [chatId, opts]),
        getHistory: async (chatId: number | string, opts?: { limit?: number }) => {
            const messages = await env.callHost("telegram.getHistory", [chatId, opts]);
            return Array.isArray(messages) ? messages.map(hydrateTelegramMessage) : [];
        },
        iterHistory: async function* (chatId: number | string, opts?: { limit?: number }) {
            const messages = await env.callHost("telegram.getHistory", [chatId, opts]);
            if (!Array.isArray(messages)) return;
            for (const message of messages) {
                yield hydrateTelegramMessage(message);
            }
        },
        iterDialogs: async function* (opts?: { limit?: number }) {
            const dialogs = await env.callHost("telegram.getDialogs", [opts]);
            if (!Array.isArray(dialogs)) return;
            for (const dialog of dialogs) {
                const raw = dialog as Record<string, unknown>;
                yield {
                    ...raw,
                    lastMessage: raw.lastMessage ? hydrateTelegramMessage(raw.lastMessage) : undefined,
                };
            }
        },
        readHistory: async (chatId: number | string) =>
            env.callHost("telegram.readHistory", [chatId]),
        sendTyping: async (chatId: number | string) => {
            await env.callHost("telegram.sendTyping", [chatId]);
            env.emitOutput(`[Telegram] sendTyping ok chat=${String(chatId)}`);
        },
    };
}

const REGISTRY: CapabilityRegistration[] = [
    {
        key: "runtime",
        install: (env) => ({
            notify: env.notifyHost,
            input: env.requestInput,
            print: env.printToHost,
            spawn: env.spawnTask,
            kill: env.killTask,
            ps: env.listTasks,
        }),
    },
    {
        key: "memory",
        install: (env) => ({
            recall: async (query: string, options?: Record<string, unknown>) =>
                env.callHost("memory.recall", [query, options]),
            browseHistory: async (request: Record<string, unknown>) =>
                env.callHost("memory.browseHistory", [request]),
            reflect: async (chatId: string) =>
                env.callHost("memory.reflect", [chatId]),
        }),
    },
    {
        key: "actions",
        install: (env) => ({
            getTopicContext: async (topicId: string) =>
                env.callHost("actions.getTopicContext", [topicId]),
            listActiveTopics: async (chatId?: string) =>
                env.callHost("actions.listActiveTopics", [chatId]),
            recallForTopic: async (topicId: string, options?: Record<string, unknown>) =>
                env.callHost("actions.recallForTopic", [topicId, options]),
        }),
    },
    {
        key: "skills",
        install: (env) => {
            const tg = createTelegramClientProxy(env);
            return {
                memory: {
                    recallAndSummarize: async (query: string, options?: Record<string, unknown>) =>
                        env.callHost("memory.recall", [query, options]),
                    browseForAnswer: async (request: Record<string, unknown>) =>
                        env.callHost("memory.browseHistory", [request]),
                },
                social: {
                    replyInTelegram: async (
                        chatId: number | string,
                        text: string,
                        opts?: { replyTo?: number }
                    ) => {
                        // tg.sendText 内部已经发射 system.agent_message_sent 通知
                        const sent = await tg.sendText(chatId, text, opts);
                        return sent;
                    },
                },
            };
        },
    },
    {
        key: "scene",
        install: (env) => ({
            /** 当前场景名称（框架自动设置，agent 无需切换） */
            current: "telegram",
            /** 列出所有可用场景 */
            list: () => {
                env.emitOutput("[Available scenes: home, telegram, memory]");
            },
            /** 展示当前场景完整类型定义 */
            showFullTypes: () => {
                env.emitOutput("[Full type definitions for current scene]");
            },
        }),
    },
];

export function installCapabilityRegistry(env: CapabilityRegistryEnv): Record<string, unknown> {
    const installed: Record<string, unknown> = {};

    if (!env.ctx.tg) {
        env.ctx.tg = createTelegramClientProxy(env);
    }

    for (const entry of REGISTRY) {
        installed[entry.key] = entry.install(env);
    }

    return installed;
}
