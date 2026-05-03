import type { SchedulerEvent, SubagentCallback, WakeConditionRecord } from "../subagent/types.js";

export interface MatchedWakeCondition {
    conditionId: string;
    condition: WakeConditionRecord["condition"];
}

export interface WakeConditionPayload {
    id: string;
    type: "wake_condition";
    description: string;
    condition: WakeConditionRecord["condition"];
    callback?: {
        taskId: string;
        chatId: string;
        status: string;
        summary: string;
    };
    reminderId?: string;
}

export function matchCallbackWakeConditions(
    callback: Pick<SubagentCallback, "taskId">,
    wakeConditions: WakeConditionRecord[],
): MatchedWakeCondition[] {
    return wakeConditions
        .filter((record) => record.condition.type === "callback_received" && record.condition.taskId === callback.taskId)
        .map((record) => ({
            conditionId: record.id,
            condition: record.condition,
        }));
}

export function matchDelayWakeReminder(
    reminder: Pick<SchedulerEvent, "chatId" | "description" | "type">,
    wakeConditions: WakeConditionRecord[],
): MatchedWakeCondition | null {
    if (reminder.type !== "reminder" || reminder.chatId !== "__meta__") {
        return null;
    }

    const prefix = "wake:";
    if (!reminder.description.startsWith(prefix)) {
        return null;
    }

    const conditionId = reminder.description.slice(prefix.length);
    const record = wakeConditions.find((item) => item.id === conditionId && item.condition.type === "delay");
    if (!record) {
        return null;
    }

    return {
        conditionId: record.id,
        condition: record.condition,
    };
}

export function buildWakeConditionPayload(
    match: MatchedWakeCondition,
    extras?: Partial<Pick<WakeConditionPayload, "callback" | "reminderId">>,
): WakeConditionPayload {
    return {
        id: match.conditionId,
        type: "wake_condition",
        description: describeWakeCondition(match.condition),
        condition: match.condition,
        ...(extras?.callback ? { callback: extras.callback } : {}),
        ...(extras?.reminderId ? { reminderId: extras.reminderId } : {}),
    };
}

function describeWakeCondition(condition: WakeConditionRecord["condition"]): string {
    switch (condition.type) {
        case "callback_received":
            return `callback received for ${condition.taskId}`;
        case "delay":
            return `delay elapsed (${condition.ms}ms)`;
        default:
            return "wake condition satisfied";
    }
}