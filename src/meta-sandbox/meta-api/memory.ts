import type {
    CoreFact,
    FactCategory,
    FactSearchResult,
    GroupModel,
    InteractionSearchResult,
    MessageSearchResult,
    PersonGroupProfile,
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

export type MemoryIdentityMatchType =
    | "exact_user_id"
    | "exact_display_name"
    | "exact_alias"
    | "exact_username"
    | "partial_display_name"
    | "partial_alias"
    | "partial_username"
    | "fact_subject"
    | "topic_participant";

export interface MemoryIdentityMatch {
    identity: PersonIdentity;
    profile: UserProfileSearchResult;
    matchType: MemoryIdentityMatchType;
    score: number;
    reasons: string[];
}

export interface MemorySearchEntitiesResult {
    identities: MemoryIdentityMatch[];
    recentSessions: TopicSearchResult[];
    sessionDigests: Array<{ createdAt: string; content: string }>;
    coreFacts: FactSearchResult[];
    topicKeywords: string[];
}

export interface MemoryResolvePersonOptions {
    chatId?: string;
    limit?: number;
}

export interface MemoryResolvePersonResult {
    matches: MemoryIdentityMatch[];
}

export interface MemoryGetPersonDossierOptions {
    chatId?: string;
    limit?: number;
    factsLimit?: number;
    interactionsLimit?: number;
    topicsLimit?: number;
    messagesLimit?: number;
    groupProfilesLimit?: number;
}

export interface MemoryDossierGroupProfile extends PersonGroupProfile {
    chatTitle?: string;
    isDirectMessage?: boolean;
}

export interface MemoryPersonDossier {
    match: MemoryIdentityMatch;
    groupProfiles: MemoryDossierGroupProfile[];
    facts: CoreFact[];
    recentInteractions: InteractionSearchResult[];
    recentTopics: TopicSearchResult[];
    recentMessages: MessageSearchResult[];
}

export interface MemoryGetPersonDossierResult {
    dossiers: MemoryPersonDossier[];
}

type MemoryEntityReader = Pick<MemoryStoreV2,
    "searchByAlias" |
    "searchFacts" |
    "searchTopics" |
    "getPersonIdentity" |
    "getUserProfile" |
    "getProfilesForChat" |
    "listGroupModels" |
    "listCoreFacts" |
    "getRecentInteractions" |
    "getRecentTopics" |
    "queryMessages"
>;

type SessionDigestReader = Pick<GlobalState, "getSessionDigests">;

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_DOSSIER_LIMIT = 3;
const MAX_DOSSIER_LIMIT = 10;

export function createMemoryApi(memory: MemoryEntityReader, globalState?: SessionDigestReader) {
    return {
        resolvePerson: async (
            query: string,
            options: MemoryResolvePersonOptions = {},
        ): Promise<MemoryResolvePersonResult> => {
            const normalizedQuery = query.trim();
            const limit = clampLimit(options.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
            if (!normalizedQuery) {
                return { matches: [] };
            }

            return {
                matches: resolvePersonMatches(memory, normalizedQuery, options.chatId, limit),
            };
        },

        getPersonDossier: async (
            queryOrUserId: string,
            options: MemoryGetPersonDossierOptions = {},
        ): Promise<MemoryGetPersonDossierResult> => {
            const normalizedQuery = queryOrUserId.trim();
            const identityLimit = clampLimit(options.limit, DEFAULT_DOSSIER_LIMIT, MAX_DOSSIER_LIMIT);
            if (!normalizedQuery) {
                return { dossiers: [] };
            }

            const matches = resolvePersonMatches(memory, normalizedQuery, options.chatId, identityLimit);
            const factsLimit = clampLimit(options.factsLimit, 12, MAX_SEARCH_LIMIT);
            const interactionsLimit = clampLimit(options.interactionsLimit, 8, MAX_SEARCH_LIMIT);
            const topicsLimit = clampLimit(options.topicsLimit, 8, MAX_SEARCH_LIMIT);
            const messagesLimit = clampLimit(options.messagesLimit, 8, MAX_SEARCH_LIMIT);
            const groupProfilesLimit = clampLimit(options.groupProfilesLimit, 8, MAX_SEARCH_LIMIT);

            return {
                dossiers: matches.map((match) => buildPersonDossier(memory, match, {
                    factsLimit,
                    interactionsLimit,
                    topicsLimit,
                    messagesLimit,
                    groupProfilesLimit,
                })),
            };
        },

        searchEntities: async (
            query: string,
            options: MemorySearchEntitiesOptions = {},
        ): Promise<MemorySearchEntitiesResult> => {
            const normalizedQuery = query.trim();
            const limit = clampLimit(options.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);

            if (!normalizedQuery) {
                return {
                    identities: [],
                    recentSessions: [],
                    sessionDigests: [],
                    coreFacts: [],
                    topicKeywords: [],
                };
            }

            const directMatches = resolvePersonMatches(memory, normalizedQuery, options.chatId, limit);
            const scoredIdentities = new Map<string, ScoredIdentity>();
            for (const match of directMatches) {
                scoredIdentities.set(match.identity.userId, {
                    identity: match.identity,
                    score: match.score,
                    matchType: match.matchType,
                    reasons: match.reasons,
                });
            }

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

            const directIdentityIds = new Set<string>();
            for (const match of directMatches) {
                directIdentityIds.add(match.identity.userId);
            }
            for (const fact of directFactMatches) {
                const identity = memory.getPersonIdentity(fact.subject);
                if (identity) {
                    directIdentityIds.add(identity.userId);
                    addScoredIdentity(scoredIdentities, identity, 60, "fact_subject", `core fact subject matched "${normalizedQuery}"`);
                }
            }
            for (const session of recentSessions) {
                for (const participantId of session.participants) {
                    const identity = memory.getPersonIdentity(participantId);
                    if (identity) {
                        addScoredIdentity(scoredIdentities, identity, 20, "topic_participant", `participant in topic "${session.label}"`);
                    }
                }
            }

            const identities = sortScoredIdentities(scoredIdentities)
                .slice(0, limit)
                .map((entry) => scoredIdentityToMatch(memory, entry, options.chatId));

            const relatedFacts = identities
                .filter((entry) => directIdentityIds.has(entry.identity.userId))
                .flatMap((entry) => entry.profile.recentFacts);
            const coreFacts = dedupeFacts([...directFactMatches, ...relatedFacts])
                .sort((left, right) => compareFacts(left, right, directIdentityIds))
                .slice(0, limit);
            const directTopicParticipantIds = new Set(directIdentityIds);
            const sortedRecentSessions = [...recentSessions]
                .sort((left, right) => compareTopics(left, right, directTopicParticipantIds))
                .slice(0, limit);
            const topicKeywords = [...new Set(recentSessions.flatMap((session) => session.keywords))]
                .slice(0, limit * 5);
            const sessionDigests = searchSessionDigests(globalState, normalizedQuery, limit);

            return {
                identities,
                recentSessions: sortedRecentSessions,
                sessionDigests,
                coreFacts,
                topicKeywords,
            };
        },
    };
}

interface ScoredIdentity {
    identity: PersonIdentity;
    score: number;
    matchType: MemoryIdentityMatchType;
    reasons: string[];
}

function resolvePersonMatches(
    memory: MemoryEntityReader,
    query: string,
    chatId: string | undefined,
    limit: number,
): MemoryIdentityMatch[] {
    const scored = new Map<string, ScoredIdentity>();

    const exactIdentity = memory.getPersonIdentity(query);
    if (exactIdentity) {
        addScoredIdentity(scored, exactIdentity, 100, "exact_user_id", "exact userId match");
    }

    for (const identity of memory.searchByAlias(query, Math.min(limit * 3, MAX_SEARCH_LIMIT))) {
        const { matchType, score, reason } = scoreAliasMatch(identity, query);
        addScoredIdentity(scored, identity, score, matchType, reason);
    }

    return sortScoredIdentities(scored)
        .slice(0, limit)
        .map((entry) => scoredIdentityToMatch(memory, entry, chatId));
}

function scoreAliasMatch(identity: PersonIdentity, query: string): {
    matchType: MemoryIdentityMatchType;
    score: number;
    reason: string;
} {
    const normalizedQuery = normalizeForMatch(query);
    const candidates: Array<{ value: string | undefined; type: "display_name" | "alias" | "username" }> = [
        { value: identity.displayName, type: "display_name" },
        { value: identity.username, type: "username" },
        ...identity.aliases.map((alias) => ({ value: alias, type: "alias" as const })),
    ];

    for (const candidate of candidates) {
        if (normalizeForMatch(candidate.value) === normalizedQuery) {
            return {
                matchType: exactMatchType(candidate.type),
                score: 95,
                reason: `exact ${candidate.type} match`,
            };
        }
    }

    for (const candidate of candidates) {
        const value = normalizeForMatch(candidate.value);
        if (value && value.startsWith(normalizedQuery)) {
            return {
                matchType: partialMatchType(candidate.type),
                score: 82,
                reason: `prefix ${candidate.type} match`,
            };
        }
    }

    for (const candidate of candidates) {
        const value = normalizeForMatch(candidate.value);
        if (value && value.includes(normalizedQuery)) {
            return {
                matchType: partialMatchType(candidate.type),
                score: 72,
                reason: `partial ${candidate.type} match`,
            };
        }
    }

    return {
        matchType: "partial_alias",
        score: 65,
        reason: "alias search fallback match",
    };
}

function exactMatchType(type: "display_name" | "alias" | "username"): MemoryIdentityMatchType {
    if (type === "display_name") return "exact_display_name";
    if (type === "username") return "exact_username";
    return "exact_alias";
}

function partialMatchType(type: "display_name" | "alias" | "username"): MemoryIdentityMatchType {
    if (type === "display_name") return "partial_display_name";
    if (type === "username") return "partial_username";
    return "partial_alias";
}

function addScoredIdentity(
    scored: Map<string, ScoredIdentity>,
    identity: PersonIdentity,
    score: number,
    matchType: MemoryIdentityMatchType,
    reason: string,
): void {
    const existing = scored.get(identity.userId);
    const recencyBonus = identity.lastSeenAt ? 1 : 0;
    const activityBonus = Math.min(Math.log10(Math.max(identity.totalMessageCount, 1)), 4);
    const finalScore = score + recencyBonus + activityBonus;

    if (!existing) {
        scored.set(identity.userId, {
            identity,
            score: finalScore,
            matchType,
            reasons: [reason],
        });
        return;
    }

    existing.reasons.push(reason);
    if (finalScore > existing.score) {
        existing.score = finalScore;
        existing.matchType = matchType;
    }
}

function sortScoredIdentities(scored: Map<string, ScoredIdentity>): ScoredIdentity[] {
    return [...scored.values()].sort((left, right) =>
        right.score - left.score
        || right.identity.totalMessageCount - left.identity.totalMessageCount
        || right.identity.lastSeenAt.localeCompare(left.identity.lastSeenAt)
    );
}

function scoredIdentityToMatch(
    memory: MemoryEntityReader,
    entry: ScoredIdentity,
    chatId?: string,
): MemoryIdentityMatch {
    return {
        identity: entry.identity,
        profile: memory.getUserProfile(entry.identity.userId, chatId),
        matchType: entry.matchType,
        score: Number(entry.score.toFixed(3)),
        reasons: [...new Set(entry.reasons)],
    };
}

function buildPersonDossier(
    memory: MemoryEntityReader,
    match: MemoryIdentityMatch,
    limits: {
        factsLimit: number;
        interactionsLimit: number;
        topicsLimit: number;
        messagesLimit: number;
        groupProfilesLimit: number;
    },
): MemoryPersonDossier {
    const groupModels = new Map(memory.listGroupModels().map((model) => [model.chatId, model]));
    const groupProfiles = collectGroupProfiles(memory, match.identity.userId, groupModels, limits.groupProfilesLimit);
    const facts = memory.listCoreFacts({ subject: match.identity.userId, limit: limits.factsLimit }).items;
    const recentInteractions = memory.getRecentInteractions(undefined, match.identity.userId, limits.interactionsLimit);
    const recentTopics = collectRecentTopics(memory, match.identity.userId, groupProfiles, limits.topicsLimit);
    const recentMessages = memory.queryMessages({
        userIds: [match.identity.userId],
        limit: limits.messagesLimit,
    });

    return {
        match,
        groupProfiles,
        facts,
        recentInteractions,
        recentTopics,
        recentMessages,
    };
}

function collectGroupProfiles(
    memory: MemoryEntityReader,
    userId: string,
    groupModels: Map<string, GroupModel>,
    limit: number,
): MemoryDossierGroupProfile[] {
    const profiles: MemoryDossierGroupProfile[] = [];
    for (const group of groupModels.values()) {
        const profile = memory.getProfilesForChat(group.chatId).find((entry) => entry.userId === userId);
        if (!profile) continue;
        profiles.push({
            ...profile,
            chatTitle: group.chatTitle,
            isDirectMessage: group.isDirectMessage,
        });
    }

    return profiles
        .sort((left, right) =>
            right.messageCount - left.messageCount
            || right.affinityScore - left.affinityScore
            || right.lastSeenAt.localeCompare(left.lastSeenAt)
        )
        .slice(0, limit);
}

function collectRecentTopics(
    memory: MemoryEntityReader,
    userId: string,
    groupProfiles: MemoryDossierGroupProfile[],
    limit: number,
): TopicSearchResult[] {
    const topics = new Map<string, TopicSearchResult>();
    for (const profile of groupProfiles.slice(0, Math.max(3, limit))) {
        const rows = memory.getRecentTopics(profile.chatId, limit * 2)
            .filter((topic) => topic.participants.includes(userId))
            .map((topic) => ({
                topicId: topic.id,
                chatId: topic.chatId,
                label: topic.label,
                summary: topic.summary,
                keywords: topic.keywords,
                participants: topic.participants,
                startedAt: topic.startedAt,
                endedAt: topic.endedAt,
                sentiment: topic.sentiment,
                callbackPotential: topic.callbackPotential ?? 0,
                associatedMemories: topic.associatedMemories ?? [],
            }));
        for (const topic of rows) {
            topics.set(topic.topicId, topic);
        }
    }

    return [...topics.values()]
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        .slice(0, limit);
}

function dedupeFacts(facts: FactSearchResult[]): FactSearchResult[] {
    const merged = new Map<string, FactSearchResult>();
    for (const fact of facts) {
        merged.set(fact.factId, fact);
    }
    return [...merged.values()];
}

function compareFacts(left: FactSearchResult, right: FactSearchResult, directIdentityIds: Set<string>): number {
    const leftDirect = directIdentityIds.has(left.subject) ? 1 : 0;
    const rightDirect = directIdentityIds.has(right.subject) ? 1 : 0;
    return rightDirect - leftDirect
        || right.updatedAt.localeCompare(left.updatedAt)
        || right.confidence - left.confidence;
}

function compareTopics(left: TopicSearchResult, right: TopicSearchResult, directIdentityIds: Set<string>): number {
    const leftDirect = left.participants.some((id) => directIdentityIds.has(id)) ? 1 : 0;
    const rightDirect = right.participants.some((id) => directIdentityIds.has(id)) ? 1 : 0;
    return rightDirect - leftDirect
        || right.startedAt.localeCompare(left.startedAt)
        || right.callbackPotential - left.callbackPotential;
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
    return Math.min(Math.max(value ?? fallback, 1), max);
}

function normalizeForMatch(value: string | undefined): string {
    return (value ?? "").trim().toLocaleLowerCase();
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
