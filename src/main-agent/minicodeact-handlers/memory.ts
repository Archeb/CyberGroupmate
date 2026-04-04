/**
 * minicodeact-handlers/memory.ts — memory 命名空间处理器
 *
 * 提供 memory.writeCoreFact / memory.updateIdentity / memory.updateProfile
 *       memory.searchIdentity / memory.getProfile
 */

import { registerHandlers, type MiniCodeActHandler, type MiniCodeActDeps } from "../minicodeact-executor.js";

function handler(
    fn: (args: Record<string, unknown>, chatId: string, deps: MiniCodeActDeps) => unknown,
    descFn: (args: Record<string, unknown>) => string,
): MiniCodeActHandler {
    const h = fn as MiniCodeActHandler;
    h.describe = descFn;
    return h;
}

registerHandlers("memory", {
    writeCoreFact: handler(
        (args, _chatId, deps) => {
            const subject = args.subject as string;
            const content = args.content as string;
            const category = args.category as string;
            if (!subject) {
                throw new Error("missing required arg: subject");
            }
            if (!content) {
                throw new Error("missing required arg: content");
            }
            if (!category) {
                throw new Error("missing required arg: category");
            }
            // 默认 0.9: minicodeact 来源的事实信心略低于人工确认（1.0）
            const confidence = (args.confidence as number) ?? 0.9;
            const factId = deps.memory.storeFact(subject, content, category as any, "minicodeact", undefined, undefined, confidence);
            return { factId };
        },
        (args) => `已记录事实: [${args.subject}] ${String(args.content ?? "").slice(0, 40)}`,
    ),

    updateIdentity: handler(
        (args, _chatId, deps) => {
            const userId = args.userId as string;
            if (!userId) {
                throw new Error("missing required arg: userId");
            }
            const existing = deps.memory.getPersonIdentity(userId);
            const aliases: string[] = existing ? [...existing.aliases] : [];

            if (args.addAlias) {
                const alias = args.addAlias as string;
                if (!aliases.includes(alias)) {
                    aliases.push(alias);
                }
            }
            if (args.removeAlias) {
                const alias = args.removeAlias as string;
                const idx = aliases.indexOf(alias);
                if (idx !== -1) aliases.splice(idx, 1);
            }

            const data: Record<string, unknown> = { aliases };
            if (args.displayName !== undefined) {
                data.displayName = args.displayName as string;
            } else if (existing) {
                data.displayName = existing.displayName;
            }

            deps.memory.upsertPersonIdentity(userId, data);
            return { success: true };
        },
        (args) => `已更新身份: ${args.userId}`,
    ),

    updateProfile: handler(
        (args, _chatId, deps) => {
            const userId = args.userId as string;
            const chatId = args.chatId as string;
            if (!userId) {
                throw new Error("missing required arg: userId");
            }
            if (!chatId) {
                throw new Error("missing required arg: chatId");
            }

            const profiles = deps.memory.getProfilesForChat(chatId);
            const existing = profiles.find((p: any) => p.userId === userId);

            const traits: string[] = existing ? [...existing.traits] : [];
            const interests: string[] = existing ? [...existing.interests] : [];

            if (args.addTraits) {
                for (const t of args.addTraits as string[]) {
                    if (!traits.includes(t)) traits.push(t);
                }
            }
            if (args.removeTraits) {
                for (const t of args.removeTraits as string[]) {
                    const idx = traits.indexOf(t);
                    if (idx !== -1) traits.splice(idx, 1);
                }
            }
            if (args.addInterests) {
                for (const i of args.addInterests as string[]) {
                    if (!interests.includes(i)) interests.push(i);
                }
            }
            if (args.removeInterests) {
                for (const i of args.removeInterests as string[]) {
                    const idx = interests.indexOf(i);
                    if (idx !== -1) interests.splice(idx, 1);
                }
            }

            const data: Record<string, unknown> = { traits, interests };
            if (args.relationToAgent !== undefined) {
                data.relationToAgent = args.relationToAgent as string;
            }

            deps.memory.upsertPersonGroupProfile(userId, chatId, data);
            return { success: true };
        },
        (args) => `已更新画像: ${args.userId} in ${args.chatId}`,
    ),

    searchIdentity: handler(
        (args, chatId, deps) => {
            const query = args.query as string;
            if (!query) {
                throw new Error("missing required arg: query");
            }
            const candidates = deps.memory.searchByAlias(query);

            // 消歧增强：结合当前 chatId 的群组画像信息
            let chatProfiles: any[] = [];
            try {
                chatProfiles = deps.memory.getProfilesForChat(chatId) ?? [];
            } catch {
                // 无群组画像时继续，不影响基本搜索
            }
            const chatUserIds = new Set(chatProfiles.map((p: any) => p.userId));

            const queryLower = query.toLowerCase();

            return {
                results: candidates.map((r: any) => {
                    const inCurrentChat = chatUserIds.has(r.userId);
                    const profile = inCurrentChat
                        ? chatProfiles.find((p: any) => p.userId === r.userId)
                        : undefined;

                    // 判定匹配类型
                    let matchType: "exact" | "alias" | "fuzzy" = "fuzzy";
                    if (r.displayName?.toLowerCase() === queryLower) {
                        matchType = "exact";
                    } else if (r.aliases?.some((a: string) => a.toLowerCase() === queryLower)) {
                        matchType = "alias";
                    }

                    return {
                        userId: r.userId,
                        displayName: r.displayName,
                        aliases: r.aliases,
                        inCurrentChat,
                        dunbarTier: profile?.dunbarTier,
                        recentMessageCount: profile?.messageCount,
                        lastSeenInChat: profile?.lastSeenAt,
                        matchType,
                    };
                }),
            };
        },
        (args) => `已搜索身份: "${args.query}"`,
    ),

    getProfile: handler(
        (args, _chatId, deps) => {
            const userId = args.userId as string;
            const chatId = args.chatId as string;
            if (!userId) {
                throw new Error("missing required arg: userId");
            }
            if (!chatId) {
                throw new Error("missing required arg: chatId");
            }
            const profiles = deps.memory.getProfilesForChat(chatId);
            const profile = profiles.find((p: any) => p.userId === userId);
            return profile ?? null;
        },
        (args) => `已查询画像: ${args.userId} in ${args.chatId}`,
    ),
});
