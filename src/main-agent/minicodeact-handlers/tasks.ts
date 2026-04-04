/**
 * minicodeact-handlers/tasks.ts — tasks 命名空间处理器
 *
 * 提供 tasks.add / tasks.update / tasks.addFollowup / tasks.completeFollowup
 */

import { registerHandlers, type MiniCodeActHandler, type MiniCodeActDeps } from "../minicodeact-executor.js";

function handler(
    fn: (args: Record<string, unknown>, chatId: string, deps: MiniCodeActDeps) => unknown,
    descFn: (args: Record<string, unknown>) => string,
): MiniCodeActHandler {
    const h = fn as MiniCodeActHandler;
    h.describe = descFn;
    return h;
}

registerHandlers("tasks", {
    add: handler(
        (args, chatId, deps) => {
            const description = args.description as string;
            if (!description) {
                throw new Error("missing required arg: description");
            }
            const priority = (args.priority as "LOW" | "MEDIUM" | "HIGH") ?? "MEDIUM";
            const taskChatId = (args.chatId as string) ?? chatId;
            const task = deps.globalState.addTask(description, taskChatId, priority);
            return { taskId: task.id };
        },
        (args) => `已创建任务: "${args.description}" (${args.priority ?? "MEDIUM"})`,
    ),

    update: handler(
        (args, _chatId, deps) => {
            const taskId = args.taskId as string;
            const status = args.status as string;
            if (!taskId || !status) {
                throw new Error("missing required args: taskId, status");
            }
            const success = deps.globalState.updateTaskStatus(taskId, status as "PENDING" | "IN_PROGRESS" | "DONE" | "CANCELLED");
            return { success };
        },
        (args) => `已更新任务 ${args.taskId} → ${args.status}`,
    ),

    addFollowup: handler(
        (args, chatId, deps) => {
            const sourceChatId = (args.sourceChatId as string) ?? chatId;
            const targetChatId = args.targetChatId as string;
            const description = args.description as string;
            if (!targetChatId || !description) {
                throw new Error("missing required args: targetChatId, description");
            }
            const followupId = deps.globalState.addFollowup(sourceChatId, targetChatId, description);
            return { followupId };
        },
        (args) => `已创建跨群待办: "${args.description}" (${args.sourceChatId} → ${args.targetChatId})`,
    ),

    completeFollowup: handler(
        (args, _chatId, deps) => {
            const followupId = args.followupId as string;
            if (!followupId) {
                throw new Error("missing required arg: followupId");
            }
            const success = deps.globalState.completeFollowup(followupId);
            return { success };
        },
        (args) => `已完成跨群待办: ${args.followupId}`,
    ),
});
