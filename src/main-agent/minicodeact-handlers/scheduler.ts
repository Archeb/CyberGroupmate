/**
 * minicodeact-handlers/scheduler.ts — scheduler 命名空间处理器
 *
 * 提供 scheduler.setReminder / scheduler.setCron / scheduler.cancel / scheduler.list
 *
 * 设计理由：触发不直接推送消息，而是写入 GlobalState.schedulerEvents，
 * 由统一调度器 Watchdog 检测到期 → boost Q3 → 主 Agent attend 时自然介入。
 *
 * 所有定时任务只接受自然语言描述，不接受代码。触发时创建新的 CodeAct session，
 * agent 在当时的上下文中自主决策执行。
 */

import { registerHandlers, type MiniCodeActHandler, type MiniCodeActDeps } from "../minicodeact-executor.js";
import { validateCronMinInterval } from "../../core/cron-matcher.js";

function handler(
    fn: (args: Record<string, unknown>, chatId: string, deps: MiniCodeActDeps) => unknown,
    descFn: (args: Record<string, unknown>) => string,
): MiniCodeActHandler {
    const h = fn as MiniCodeActHandler;
    h.describe = descFn;
    return h;
}

/** 简单的 cron 表达式格式验证：至少 5 个空格分隔的字段 */
function isValidCronExpr(expr: string): boolean {
    const parts = expr.trim().split(/\s+/);
    return parts.length >= 5 && parts.length <= 7;
}

registerHandlers("scheduler", {
    setReminder: handler(
        (args, chatId, deps) => {
            const targetChatId = (args.chatId as string) ?? chatId;
            const description = args.description as string;
            const triggerAt = args.triggerAt as string;

            if (!description) {
                throw new Error("missing required arg: description");
            }
            if (!triggerAt) {
                throw new Error("missing required arg: triggerAt");
            }

            // 验证 ISO 8601 格式
            const parsed = new Date(triggerAt);
            if (isNaN(parsed.getTime())) {
                throw new Error(`invalid triggerAt format: "${triggerAt}" (expected ISO 8601)`);
            }

            // 不允许设置过去的时间
            if (parsed.getTime() < Date.now() - 60_000) {
                throw new Error("triggerAt is in the past");
            }

            // 最长 365 天
            if (parsed.getTime() > Date.now() + 365 * 24 * 60 * 60_000) {
                throw new Error("triggerAt 最长 365 天");
            }

            const requestedBy = args.requestedBy as string | undefined;
            const event = deps.globalState.addReminder(targetChatId, description, parsed.toISOString(), requestedBy);
            return { reminderId: event.id };
        },
        (args) => `已设置提醒: "${args.description}" → ${args.triggerAt}`,
    ),

    setCron: handler(
        (args, chatId, deps) => {
            const targetChatId = (args.chatId as string) ?? chatId;
            const description = args.description as string;
            const cronExpr = args.cronExpr as string;
            const taskTemplate = args.taskTemplate as string;

            if (!description) {
                throw new Error("missing required arg: description");
            }
            if (!cronExpr) {
                throw new Error("missing required arg: cronExpr");
            }
            if (!taskTemplate) {
                throw new Error("missing required arg: taskTemplate (自然语言任务描述)");
            }
            if (!isValidCronExpr(cronExpr)) {
                throw new Error(`invalid cron expression: "${cronExpr}" (expected 5-7 fields)`);
            }
            // 最短间隔 1 小时
            if (!validateCronMinInterval(cronExpr, 60)) {
                throw new Error("cron 最短触发间隔为 1 小时");
            }

            const event = deps.globalState.addCron(targetChatId, description, cronExpr, taskTemplate);
            return { cronId: event.id };
        },
        (args) => `已设置 cron: "${args.description}" (${args.cronExpr})`,
    ),

    cancel: handler(
        (args, _chatId, deps) => {
            const id = args.id as string;
            if (!id) {
                throw new Error("missing required arg: id");
            }
            const success = deps.globalState.cancelSchedulerEvent(id);
            return { success };
        },
        (args) => `已取消调度: ${args.id}`,
    ),

    list: handler(
        (args, chatId, deps) => {
            const targetChatId = (args.chatId as string) ?? chatId;
            const events = deps.globalState.getSchedulerEvents(targetChatId);
            return {
                events: events.map(e => ({
                    id: e.id,
                    type: e.type,
                    description: e.description,
                    triggerAt: e.triggerAt,
                    cronExpr: e.cronExpr,
                    taskTemplate: e.taskTemplate,
                    triggered: e.triggered,
                })),
            };
        },
        (args) => `已查询调度列表: ${args.chatId ?? "(全部)"}`,
    ),
});
