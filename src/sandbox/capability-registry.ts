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
    install: (env: CapabilityRegistryEnv, sentHistory?: Map<string, Set<string>>) => unknown;
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

function createTelegramClientProxy(env: CapabilityRegistryEnv, sentHistory: Map<string, Set<string>>) {
    /**
     * 检查消息是否是重复发送。
     * 如果是新消息则记录并返回 false；如果已发送过则返回 true。
     */
    function isDuplicate(chatId: string, text: string): boolean {
        const key = String(chatId);
        const existing = sentHistory.get(key);
        if (existing && existing.has(text)) {
            return true;
        }
        if (!existing) {
            sentHistory.set(key, new Set([text]));
        } else {
            existing.add(text);
        }
        return false;
    }

    return {
        getMe: async () => env.callHost("telegram.getMe", []),
        sendText: async (chatId: number | string, text: string, opts?: { replyTo?: number }) => {
            // ── 重复消息拦截 ──
            if (isDuplicate(String(chatId), text)) {
                const warning = `[⚠ 运行时警告: 重复消息已拦截] 目标 chat=${String(chatId)} 的消息 "${text.length > 80 ? text.slice(0, 80) + '...' : text}" 与本次 session 中已发送的消息内容完全一致，已自动拦截，不会重复发送。`;
                env.emitOutput(warning);
                env.notifyHost({
                    type: "system.duplicate_message_blocked",
                    scene: "telegram",
                    chatId: String(chatId),
                    text,
                    timestamp: new Date().toISOString(),
                });
                return null;
            }
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
            // ── 重复消息拦截（基于 caption）──
            const mediaText = opts?.caption ?? "[media]";
            if (isDuplicate(String(chatId), mediaText)) {
                const warning = `[⚠ 运行时警告: 重复消息已拦截] 目标 chat=${String(chatId)} 的媒体消息 "${mediaText.length > 80 ? mediaText.slice(0, 80) + '...' : mediaText}" 与本次 session 中已发送的消息内容完全一致，已自动拦截，不会重复发送。`;
                env.emitOutput(warning);
                env.notifyHost({
                    type: "system.duplicate_message_blocked",
                    scene: "telegram",
                    chatId: String(chatId),
                    text: mediaText,
                    timestamp: new Date().toISOString(),
                });
                return null;
            }
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
        joinChat: async (chatId: number | string) => {
            await env.callHost("telegram.joinChat", [chatId]);
            env.emitOutput(`[Telegram] joinChat ok chat=${String(chatId)}`);
        },
        leaveChat: async (chatId: number | string) => {
            await env.callHost("telegram.leaveChat", [chatId]);
            env.emitOutput(`[Telegram] leaveChat ok chat=${String(chatId)}`);
        },
        getDialogs: async (opts?: { limit?: number }) => {
            const dialogs = await env.callHost("telegram.getDialogs", [opts]);
            return Array.isArray(dialogs) ? dialogs : [];
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
        install: (env, sentHistory) => {
            const tg = createTelegramClientProxy(env, sentHistory ?? new Map());
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
                        // tg.sendText 内部已经发射 system.agent_message_sent 通知 + 去重检查
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

    // 创建 session 级别的发送历史，用于去重检测
    const sentHistory = new Map<string, Set<string>>();

    if (!env.ctx.tg) {
        env.ctx.tg = createTelegramClientProxy(env, sentHistory);
    }

    for (const entry of REGISTRY) {
        if (entry.key === "skills") {
            // skills 需要共享同一个 sentHistory
            installed[entry.key] = entry.install(env, sentHistory);
        } else {
            installed[entry.key] = entry.install(env);
        }
    }

    return installed;
}
