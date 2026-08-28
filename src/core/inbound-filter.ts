import { getRawId, parseChatId } from "./chat-id.js";
import type { ChatFilterConfig } from "./config.js";

export interface InboundFilterTarget {
    chatId: string;
    userId?: string;
}

/**
 * Evaluate the global inbound filter. Chat and sender entries share the same
 * mode; matching either list counts as a match.
 */
export function shouldDropInbound(
    config: ChatFilterConfig | undefined,
    target: InboundFilterTarget,
): boolean {
    if (!config?.enabled) return false;

    const chatCandidates = chatIdCandidates(target.chatId);
    if (
        (config.mode ?? "blacklist") === "blacklist"
        && matchesFilterList(config.allowedChatIds, chatCandidates)
    ) {
        return false;
    }

    const listed = matchesFilterList(config.chatIds, chatCandidates)
        || matchesFilterList(config.userIds, idCandidates(target.userId));

    return (config.mode ?? "blacklist") === "whitelist" ? !listed : listed;
}

/**
 * Return a copy of the filter config that releases one whole chat.
 *
 * Exact blacklist entries are removed. If a wildcard or sender rule would
 * still block the chat, an explicit chat-level exception is added instead of
 * deleting the broader rule.
 */
export function releaseChatFromFilter(
    config: ChatFilterConfig,
    chatId: string,
): ChatFilterConfig {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) return { ...config };

    const next: ChatFilterConfig = {
        ...config,
        chatIds: [...(config.chatIds ?? [])],
        userIds: [...(config.userIds ?? [])],
        allowedChatIds: [...(config.allowedChatIds ?? [])],
    };

    if ((next.mode ?? "blacklist") === "whitelist") {
        if (!next.chatIds!.includes(normalizedChatId)) {
            next.chatIds!.push(normalizedChatId);
        }
        return next;
    }

    const candidates = chatIdCandidates(normalizedChatId);
    next.chatIds = next.chatIds!.filter((pattern) => {
        const trimmed = pattern.trim();
        return trimmed.includes("*") || !matchesFilterList([trimmed], candidates);
    });

    if ((next.userIds?.length ?? 0) > 0 || shouldDropInbound(next, { chatId: normalizedChatId })) {
        if (!next.allowedChatIds!.includes(normalizedChatId)) {
            next.allowedChatIds!.push(normalizedChatId);
        }
    }
    return next;
}

export function matchesFilterList(
    patterns: readonly string[] | undefined,
    candidates: readonly string[],
): boolean {
    if (!patterns?.length || candidates.length === 0) return false;
    return patterns.some((rawPattern) => {
        const pattern = rawPattern.trim();
        return pattern !== "" && candidates.some((candidate) => matchesGlob(pattern, candidate));
    });
}

function chatIdCandidates(chatId: string): string[] {
    const candidates = idCandidates(chatId);
    if (!chatId) return candidates;

    try {
        const parsed = parseChatId(chatId);
        addCandidate(candidates, parsed.groupId);
        addCandidate(candidates, parsed.channelId);

        // OneBot raw IDs are typed (group:123 / private:456). Accepting the
        // leaf keeps documented raw numeric IDs useful across every platform.
        const typedRaw = /^(?:group|private):(.+)$/.exec(parsed.rawId);
        addCandidate(candidates, typedRaw?.[1]);
    } catch {
        // Raw IDs are valid filter targets too.
    }

    return candidates;
}

function idCandidates(id: string | undefined): string[] {
    if (!id?.trim()) return [];
    const value = id.trim();
    const candidates = [value];
    addCandidate(candidates, getRawId(value));
    return candidates;
}

function addCandidate(candidates: string[], value: string | undefined): void {
    if (value && !candidates.includes(value)) candidates.push(value);
}

/** Match a small shell-style glob where only `*` has special meaning. */
function matchesGlob(pattern: string, value: string): boolean {
    if (!pattern.includes("*")) return pattern === value;
    if (pattern === "*") return true;

    const parts = pattern.split("*");
    let cursor = 0;

    if (parts[0]) {
        if (!value.startsWith(parts[0])) return false;
        cursor = parts[0].length;
    }

    for (let index = 1; index < parts.length - 1; index++) {
        const part = parts[index];
        if (!part) continue;
        const foundAt = value.indexOf(part, cursor);
        if (foundAt === -1) return false;
        cursor = foundAt + part.length;
    }

    const tail = parts.at(-1) ?? "";
    if (!tail) return true;
    const tailAt = value.length - tail.length;
    return tailAt >= cursor && value.endsWith(tail);
}
