import { validateCronMinInterval } from "../../core/cron-matcher.js";
import type { GlobalState } from "../../main-agent/global-state.js";
import type { SchedulerEvent } from "../../subagent/types.js";

type SchedulerState = Pick<GlobalState,
    "addReminder" |
    "addCron" |
    "getSchedulerEvents" |
    "cancelSchedulerEvent"
>;

export interface ReminderSetInput {
    name: string;
    callback: string;
    bindingId?: string;
    triggerAt?: string;
    delayMinutes?: number;
    data?: unknown;
}

export interface CronSetInput {
    name: string;
    cronExpr: string;
    callback: string;
    bindingId?: string;
    data?: unknown;
}

export interface SchedulerListInput {
    bindingId?: string;
    includeTriggered?: boolean;
}

export function createReminderApi(globalState: SchedulerState) {
    return {
        get: async (id: string) => findEvent(globalState, id, "reminder"),
        list: async (options: SchedulerListInput = {}) =>
            listEvents(globalState, "reminder", options),
        set: async (input: ReminderSetInput) => {
            const bindingId = normalizeBindingId(input.bindingId);
            const callback = requireCallback(input.callback);
            const triggerAt = resolveTriggerAt(input);
            const event = globalState.addReminder(
                "__meta__",
                callback,
                triggerAt,
                "scheduler-api",
                {
                    bindingId,
                    name: input.name,
                    callback,
                    data: input.data,
                },
            );
            return normalizeEvent(event);
        },
        delete: async (id: string) => {
            return globalState.cancelSchedulerEvent(id);
        },
    };
}

export function createCronApi(globalState: SchedulerState) {
    return {
        get: async (id: string) => findEvent(globalState, id, "cron"),
        list: async (options: SchedulerListInput = {}) =>
            listEvents(globalState, "cron", options),
        set: async (input: CronSetInput) => {
            const bindingId = normalizeBindingId(input.bindingId);
            const callback = requireCallback(input.callback);
            if (!validateCronMinInterval(input.cronExpr, 60)) {
                throw new Error("cron 最短触发间隔为 1 小时");
            }
            const duplicate = globalState.getSchedulerEvents()
                .find((event) =>
                    event.type === "cron"
                    && (event.bindingId ?? event.chatId) === bindingId
                    && event.cronExpr === input.cronExpr
                    && (event.callback ?? event.taskTemplate ?? event.description) === callback
                );
            if (duplicate) {
                throw new Error(`已存在完全相同的 cron: ${duplicate.id}`);
            }
            const event = globalState.addCron(
                "__meta__",
                input.name,
                input.cronExpr,
                callback,
                {
                    bindingId,
                    name: input.name,
                    callback,
                    data: input.data,
                },
            );
            return normalizeEvent(event);
        },
        delete: async (id: string) => {
            return globalState.cancelSchedulerEvent(id);
        },
    };
}

function resolveTriggerAt(input: ReminderSetInput): string {
    if (input.triggerAt) {
        const parsed = new Date(input.triggerAt);
        if (Number.isNaN(parsed.getTime())) {
            throw new Error(`Invalid triggerAt: ${input.triggerAt}`);
        }
        return parsed.toISOString();
    }
    if (typeof input.delayMinutes !== "number") {
        throw new Error("remind.set 需要 triggerAt 或 delayMinutes");
    }
    if (input.delayMinutes < 1) {
        throw new Error("remind 最短 1 分钟");
    }
    if (input.delayMinutes > 525600) {
        throw new Error("remind 最长 365 天（525600 分钟）");
    }
    return new Date(Date.now() + input.delayMinutes * 60_000).toISOString();
}

function requireCallback(callback: string): string {
    const trimmed = String(callback ?? "").trim();
    if (!trimmed) {
        throw new Error("callback 不能为空：必须写清楚被唤醒后要做什么");
    }
    return trimmed;
}

function findEvent(globalState: SchedulerState, id: string, type: SchedulerEvent["type"]) {
    const event = globalState.getSchedulerEvents().find((item) => item.id === id && item.type === type);
    return event ? normalizeEvent(event) : null;
}

function listEvents(globalState: SchedulerState, type: SchedulerEvent["type"], options: SchedulerListInput) {
    return globalState.getSchedulerEvents()
        .filter((event) => event.type === type)
        .filter((event) => !options.bindingId || (event.bindingId ?? event.chatId) === normalizeBindingId(options.bindingId))
        .filter((event) => options.includeTriggered || !event.triggered)
        .map(normalizeEvent);
}

function normalizeEvent(event: SchedulerEvent) {
    const callback = event.callback ?? event.taskTemplate ?? event.description;
    const bindingId = normalizeBindingId(event.bindingId ?? (event.chatId === "__meta__" ? "meta" : event.chatId));
    return {
        id: event.id,
        type: event.type,
        bindingId,
        name: event.name ?? event.description,
        callback,
        data: event.data,
        triggerAt: event.triggerAt,
        cronExpr: event.cronExpr,
        createdAt: event.createdAt,
        triggered: event.triggered,
        lastTriggeredAt: event.lastTriggeredAt,
    };
}

function normalizeBindingId(bindingId?: string): string {
    const value = bindingId?.trim();
    return value && value.length > 0 ? value : "meta";
}
