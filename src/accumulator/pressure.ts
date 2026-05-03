import type { PressureInput } from "./types.js";

const CHAR_CAP = 200;

const TIER_WEIGHT: Record<1 | 2 | 3 | 4, number> = {
    1: 2.0,
    2: 1.5,
    3: 1.0,
    4: 0.7,
};

const STICKINESS_MULTIPLIER = {
    CORE: 2.0,
    FAMILIAR: 1.2,
    ACQUAINTANCE: 0.8,
    STRANGER: 0.5,
} as const;

export function calculatePressure(input: PressureInput): number {
    const participantVolume = input.participants.reduce((sum, participant) => {
        if (participant.messageCount <= 0) return sum;
        const averageChars = participant.totalChars / participant.messageCount;
        const cappedAverageChars = Math.min(averageChars, CHAR_CAP);
        return sum + participant.messageCount * cappedAverageChars * TIER_WEIGHT[participant.dunbarTier];
    }, 0);

    const ageFactor = 1 + Math.max(0, input.ageMinutes) * 0.02;
    const ignoredPenalty = input.ignoredCount > 0 ? 0.3 : 1.0;

    return participantVolume
        * STICKINESS_MULTIPLIER[input.stickinessLevel]
        * ageFactor
        * ignoredPenalty;
}