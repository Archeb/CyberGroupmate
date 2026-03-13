/**
 * task-list.ts — TaskList Skill (sandbox host-call)
 *
 * 提供 sandbox 内的 CodeAct session 通过 host-call 访问
 * 主 Agent 任务列表的能力。
 *
 * 注册为 host-call:
 *   skills.taskList.list() → AgentTask[]
 *   skills.taskList.add(description, chatId?, priority?) → AgentTask
 *   skills.taskList.update(taskId, status) → boolean
 *
 * 参考设计：subagent.md §9.2, subtask.md S6.2
 */

import type { AgentTask } from "../../subagent/types.js";
import type { GlobalState } from "../../main-agent/global-state.js";
import { createLogger } from "../../core/logger.js";

const log = createLogger("skill-task-list");

/** TaskList skill 接口 */
export interface TaskListSkill {
    /** 列出所有任务 */
    list(filter?: { status?: string; chatId?: string }): AgentTask[];
    /** 添加新任务 */
    add(description: string, chatId?: string, priority?: "LOW" | "MEDIUM" | "HIGH"): AgentTask;
    /** 更新任务状态 */
    update(taskId: string, status: AgentTask["status"]): boolean;
}

/**
 * 创建 TaskList skill 实例
 *
 * 需要 GlobalState 引用，在 sandbox host-call 注册时注入。
 */
export function createTaskListSkill(globalState: GlobalState): TaskListSkill {
    return {
        list(filter?: { status?: string; chatId?: string }): AgentTask[] {
            let tasks = globalState.getTaskList();

            if (filter?.status) {
                tasks = tasks.filter(t => t.status === filter.status);
            }
            if (filter?.chatId) {
                tasks = tasks.filter(t => t.chatId === filter.chatId);
            }

            log.debug("list", { filter, count: tasks.length });
            return tasks;
        },

        add(description: string, chatId?: string, priority: "LOW" | "MEDIUM" | "HIGH" = "MEDIUM"): AgentTask {
            const task = globalState.addTask(description, chatId, priority);
            log.info("add", { taskId: task.id, description, chatId, priority });
            return task;
        },

        update(taskId: string, status: AgentTask["status"]): boolean {
            const result = globalState.updateTaskStatus(taskId, status);
            log.info("update", { taskId, status, success: result });
            return result;
        },
    };
}

/**
 * 构建 host-call handler map（用于 Sandbox.registerHostCallHandler）
 */
export function buildTaskListHostCalls(skill: TaskListSkill): Record<string, (args: unknown) => unknown> {
    return {
        "skills.taskList.list": (args: unknown) => {
            const filter = (args && typeof args === "object") ? args as { status?: string; chatId?: string } : undefined;
            return skill.list(filter);
        },
        "skills.taskList.add": (args: unknown) => {
            const a = args as { description: string; chatId?: string; priority?: "LOW" | "MEDIUM" | "HIGH" };
            return skill.add(a.description, a.chatId, a.priority);
        },
        "skills.taskList.update": (args: unknown) => {
            const a = args as { taskId: string; status: AgentTask["status"] };
            return skill.update(a.taskId, a.status);
        },
    };
}
