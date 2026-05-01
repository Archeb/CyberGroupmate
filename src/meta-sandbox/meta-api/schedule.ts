import type { GlobalState } from "../../main-agent/global-state.js";
import type { SchedulerEvent, WakeCondition } from "../../subagent/types.js";

type ScheduleStateReader = Pick<GlobalState,
    "addWakeCondition" |
    "removeWakeCondition" |
    "addReminder" |
    "getSchedulerEvents" |
    "cancelSchedulerEvent"
>;

export function createScheduleApi(globalState: ScheduleStateReader) {
    return {
        wakeOnCondition: async (condition: WakeCondition): Promise<{ conditionId: string; reminderId?: string }> => {
            const conditionId = globalState.addWakeCondition(condition);

            if (condition.type !== "delay") {
                return { conditionId };
            }

            const triggerAt = new Date(Date.now() + condition.ms).toISOString();
            const reminder = globalState.addReminder("__meta__", `wake:${conditionId}`, triggerAt, "meta-schedule");
            return { conditionId, reminderId: reminder.id };
        },
        cancel: async (conditionId: string): Promise<{ removedWakeCondition: boolean; removedReminderIds: string[] }> => {
            const removedWakeCondition = globalState.removeWakeCondition(conditionId);
            const removedReminderIds = globalState
                .getSchedulerEvents("__meta__")
                .filter((event) => isMetaWakeReminder(event, conditionId))
                .map((event) => event.id)
                .filter((id) => globalState.cancelSchedulerEvent(id));

            return { removedWakeCondition, removedReminderIds };
        },
    };
}

function isMetaWakeReminder(event: SchedulerEvent, conditionId: string): boolean {
    return event.type === "reminder" && event.description === `wake:${conditionId}`;
}