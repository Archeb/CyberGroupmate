import type {
    FactCategory,
    FactSearchResult,
    PersonIdentity,
    TopicSearchResult,
    UserProfileSearchResult,
    MemoryStoreV2,
} from "../../memory-v2/index.js";
import type { GlobalState } from "../../main-agent/global-state.js";

export interface MemorySearchEntitiesOptions {
    chatId?: string;
    after?: string;
    before?: string;
    categories?: FactCategory[];
    limit?: number;
}

export interface MemoryIdentityMatch {
    identity: PersonIdentity;
    profile: UserProfileSearchResult;
}

export interface MemorySearchEntitiesResult {
    identities: MemoryIdentityMatch[];
    recentSessions: TopicSearchResult[];
    sessionDigests: Array<{ createdAt: string; content: string }>;
    coreFacts: FactSearchResult[];
    topicKeywords: string[];
}

type MemoryEntityReader = Pick<MemoryStoreV2,
    "searchByAlias" |
    "searchFacts" |
    "searchTopics" |
    "getPersonIdentity" |
    "getUserProfile"
>;

type SessionDigestReader = Pick<GlobalState, "getSessionDigests">;

export function createMemoryApi(memory: MemoryEntityReader, globalState?: SessionDigestReader) {
    return {
        searchEntities: async (
            query: string,
            options: MemorySearchEntitiesOptions = {},
        ): Promise<MemorySearchEntitiesResult> => {
            const normalizedQuery = query.trim();
            const limit = clampLimit(options.limit, 10, 50);

            if (!normalizedQuery) {
                return {
                    identities: [],
                    recentSessions: [],
                    sessionDigests: [],
                    coreFacts: [],
                    topicKeywords: [],
                };
            }

            const aliasMatches = memory.searchByAlias(normalizedQuery, limit);
            const recentSessions = memory.searchTopics(normalizedQuery, {
                chatId: options.chatId,
                after: options.after,
                before: options.before,
                limit,
            });
            const directFactMatches = memory.searchFacts(normalizedQuery, {
                categories: options.categories,
                limit,
            });

            const allIdentityIds = new Set<string>();
            const directIdentityIds = new Set<string>();

            for (const identity of aliasMatches) {
                allIdentityIds.add(identity.userId);
                directIdentityIds.add(identity.userId);
            }
            for (const fact of directFactMatches) {
                const identity = memory.getPersonIdentity(fact.subject);
                if (identity) {
                    allIdentityIds.add(identity.userId);
                    directIdentityIds.add(identity.userId);
                }
            }
            for (const session of recentSessions) {
                for (const participantId of session.participants) {
                    if (memory.getPersonIdentity(participantId)) {
                        allIdentityIds.add(participantId);
                    }
                }
            }

            const identities = [...allIdentityIds]
                .map((userId) => memory.getPersonIdentity(userId))
                .filter((identity): identity is PersonIdentity => identity !== null)
                .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
                .slice(0, limit)
                .map((identity) => ({
                    identity,
                    profile: memory.getUserProfile(identity.userId, options.chatId),
                }));

            const relatedFacts = identities
                .filter((entry) => directIdentityIds.has(entry.identity.userId))
                .flatMap((entry) => entry.profile.recentFacts);
            const coreFacts = dedupeFacts([...directFactMatches, ...relatedFacts])
                .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
                .slice(0, limit);
            const topicKeywords = [...new Set(recentSessions.flatMap((session) => session.keywords))]
                .slice(0, limit * 5);
            const sessionDigests = searchSessionDigests(globalState, normalizedQuery, limit);

            return {
                identities,
                recentSessions: recentSessions.slice(0, limit),
                sessionDigests,
                coreFacts,
                topicKeywords,
            };
        },
    };
}

function dedupeFacts(facts: FactSearchResult[]): FactSearchResult[] {
    const merged = new Map<string, FactSearchResult>();
    for (const fact of facts) {
        merged.set(fact.factId, fact);
    }
    return [...merged.values()];
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
    return Math.min(Math.max(value ?? fallback, 1), max);
}

function searchSessionDigests(
    globalState: SessionDigestReader | undefined,
    query: string,
    limit: number,
): Array<{ createdAt: string; content: string }> {
    if (!globalState) {
        return [];
    }
    const lowered = query.toLocaleLowerCase();
    return globalState.getSessionDigests()
        .filter((digest) =>
            digest.content.toLocaleLowerCase().includes(lowered)
            || digest.createdAt.toLocaleLowerCase().includes(lowered)
        )
        .slice(-limit)
        .reverse();
}
