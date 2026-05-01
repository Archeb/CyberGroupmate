import { calculatePressure } from "../accumulator/pressure.js";
import type { PressureParticipant } from "../accumulator/types.js";
import { ensureCompositeId, getPlatform } from "../core/chat-id.js";
import type { PersonGroupProfile } from "../memory-v2/types.js";
import type { StickinessLevel, TopicDigest } from "../subagent/types.js";
import { TopicRegistry } from "./topic-registry.js";
import type { Message, Topic } from "./types.js";

export interface TopicSignalPressureInput {
    participants: PressureParticipant[];
    stickinessLevel: StickinessLevel;
}

export interface TopicSignalPayload {
    topicDigest: TopicDigest;
    pressureInput: TopicSignalPressureInput;
}

export interface TopicSignalEntry {
    chatId: string;
    topicId: string;
    topicLabel: string;
    reason?: string;
    callbackPotential: number;
    enqueuedAt: number;
    pressure: number;
    payload: TopicSignalPayload;
}

interface BuildTopicSignalEntriesInput {
    chatId: string;
    topics: Topic[];
    topicMessagesById: Map<string, Message[]>;
    profiles: PersonGroupProfile[];
    stickinessLevel: StickinessLevel;
    now?: number;
}

export function buildTopicSignalEntries(input: BuildTopicSignalEntriesInput): TopicSignalEntry[] {
    const now = input.now ?? Date.now();
    const compositeProfileMap = new Map(input.profiles.map((profile) => [profile.userId, profile]));
    const platform = getPlatform(input.chatId);

    return input.topics.flatMap((topic) => {
        const topicMessages = input.topicMessagesById.get(topic.id) ?? [];
        const participants = buildPressureParticipants(platform, topicMessages, compositeProfileMap);
        if (participants.length === 0) {
            return [];
        }

        const pressureInput: TopicSignalPressureInput = {
            participants,
            stickinessLevel: input.stickinessLevel,
        };

        return [{
            chatId: input.chatId,
            topicId: topic.id,
            topicLabel: topic.label,
            reason: topic.decision?.reason,
            callbackPotential: topic.callbackPotential ?? 0,
            enqueuedAt: now,
            pressure: calculatePressure({
                ...pressureInput,
                ageMinutes: 0,
                ignoredCount: 0,
            }),
            payload: {
                topicDigest: TopicRegistry.toDigest(topic),
                pressureInput,
            },
        }];
    });
}

function buildPressureParticipants(
    platform: ReturnType<typeof getPlatform>,
    messages: Message[],
    profiles: Map<string, PersonGroupProfile>,
): PressureParticipant[] {
    const stats = new Map<string, { messageCount: number; totalChars: number }>();

    for (const message of messages) {
        const current = stats.get(message.senderId) ?? { messageCount: 0, totalChars: 0 };
        current.messageCount += 1;
        current.totalChars += message.text.length;
        stats.set(message.senderId, current);
    }

    return [...stats.entries()].map(([senderId, stat]) => {
        const compositeUserId = ensureCompositeId(platform, senderId);
        return {
            messageCount: stat.messageCount,
            totalChars: stat.totalChars,
            dunbarTier: profiles.get(compositeUserId)?.dunbarTier ?? 4,
        };
    });
}