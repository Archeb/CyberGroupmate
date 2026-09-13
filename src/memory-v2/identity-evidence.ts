import type { RecentMessageEntry } from "./types.js";

/** Reflection may propose aliases; only the account's own evidence can confirm them. */
export function groundedIdentityUpdate(
    userId: string,
    proposal: { displayName?: string; aliases?: string[] },
    evidence: RecentMessageEntry[],
    existingAliases: string[] = [],
): { displayName?: string; aliases?: string[] } {
    const ownMessages = evidence.filter(message => message.userId === userId);
    const result: { displayName?: string; aliases?: string[] } = {};
    // Platform display names are written by ingestion. Reflection cannot rename an account.
    const aliases = (Array.isArray(proposal.aliases) ? proposal.aliases : []).filter(alias => {
        if (typeof alias !== "string" || !alias.trim() || alias.length > 80 || alias !== alias.trim()) return false;
        return ownMessages.some(message => {
            if (message.displayName === alias) return true;
            // Deliberately narrow: quotes, peer nicknames and role-play are not account evidence.
            const claim = /^(?:以后)?(?:请)?(?:叫我|我叫|我的(?:昵称|名字|别名)(?:是|叫))\s*(.+?)[。！!]?$/u.exec(message.text.trim());
            return claim?.[1] === alias;
        });
    });
    if (aliases.length) result.aliases = [...new Set([...existingAliases, ...aliases])];
    return result;
}
