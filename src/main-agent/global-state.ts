/**
 * global-state.ts — 主 Agent 全局状态管理
 *
 * 持久化存储主 Agent 的全局状态：
 * - 任务列表 (TaskList)
 * - 最近决策记录
 * - 跨群待办事项
 * - 注意力概要
 *
 * 使用 JSON 文件持久化，支持损坏恢复。
 *
 * 参考设计：subagent.md §9, subtask.md S6
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MainAgentGlobalState, AgentTask, AgentNote, SchedulerEvent } from "../subagent/types.js";
import { createLogger } from "../core/logger.js";
import { randomUUID } from "node:crypto";

const log = createLogger("global-state");

/** GlobalState 配置 */
export interface GlobalStateConfig {
    /** 持久化文件路径。默认 workspace/global-state.json */
    filePath: string;
    /** 最大最近决策数。默认 50 */
    maxRecentDecisions: number;
    /** 自动保存间隔 (ms)。0 = 不自动保存。默认 30000 */
    autoSaveInterval: number;
}

const DEFAULT_CONFIG: GlobalStateConfig = {
    filePath: "workspace/global-state.json",
    maxRecentDecisions: 50,
    autoSaveInterval: 30000,
};

/**
 * GlobalState — 主 Agent 全局状态管理器
 */
export class GlobalState {
    private state: MainAgentGlobalState;
    private config: GlobalStateConfig;
    private dirty = false;
    private autoSaveTimer: ReturnType<typeof setInterval> | null = null;

    constructor(config?: Partial<GlobalStateConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.state = this.load();

        // 自动保存
        if (this.config.autoSaveInterval > 0) {
            this.autoSaveTimer = setInterval(() => {
                if (this.dirty) this.save();
            }, this.config.autoSaveInterval);
            if (this.autoSaveTimer.unref) this.autoSaveTimer.unref();
        }
    }

    // ─── 读取 ───

    /** 获取全局状态快照 */
    getState(): Readonly<MainAgentGlobalState> {
        return { ...this.state };
    }

    /** 获取任务列表 */
    getTaskList(): AgentTask[] {
        return [...this.state.taskList];
    }

    /** 获取最近决策 */
    getRecentDecisions(): ReadonlyArray<{ chatId: string; decision: string; timestamp: string }> {
        return this.state.recentDecisions;
    }

    /** 获取注意力概要 */
    getAttentionSummary(): string {
        return this.state.attentionSummary;
    }

    /** 获取跨群待办列表 (subagent.md 场景 5) */
    getPendingFollowups(): ReadonlyArray<MainAgentGlobalState["pendingFollowups"][number]> {
        return this.state.pendingFollowups;
    }

    // ─── 写入 ───

    /** 添加任务 */
    addTask(description: string, chatId?: string, priority: "LOW" | "MEDIUM" | "HIGH" = "MEDIUM"): AgentTask {
        const task: AgentTask = {
            id: randomUUID(),
            description,
            status: "PENDING",
            chatId,
            priority,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        this.state.taskList.push(task);
        this.markDirty();
        log.debug("addTask", { taskId: task.id, description });
        return task;
    }

    /** 更新任务状态 */
    updateTaskStatus(taskId: string, status: AgentTask["status"]): boolean {
        const task = this.state.taskList.find(t => t.id === taskId);
        if (!task) return false;

        task.status = status;
        task.updatedAt = new Date().toISOString();
        if (status === "DONE" || status === "CANCELLED") {
            task.completedAt = new Date().toISOString();
        }
        this.markDirty();
        return true;
    }

    /** 记录决策 */
    recordDecision(chatId: string, decision: string): void {
        this.state.recentDecisions.push({
            chatId,
            decision,
            timestamp: new Date().toISOString(),
        });

        // 保持最大数量
        while (this.state.recentDecisions.length > this.config.maxRecentDecisions) {
            this.state.recentDecisions.shift();
        }

        this.state.lastActiveAt = new Date().toISOString();
        this.markDirty();
    }

    /** 更新注意力概要 */
    updateAttentionSummary(summary: string): void {
        this.state.attentionSummary = summary;
        this.markDirty();
    }

    /** 添加跨群待办 */
    addFollowup(sourceChatId: string, targetChatId: string, description: string): string {
        const id = randomUUID();
        this.state.pendingFollowups.push({
            id,
            sourceChatId,
            targetChatId,
            description,
            status: "PENDING",
            createdAt: new Date().toISOString(),
        });
        this.markDirty();
        return id;
    }

    /** 完成跨群待办 */
    completeFollowup(followupId: string): boolean {
        const fu = this.state.pendingFollowups.find(f => f.id === followupId);
        if (!fu) return false;

        fu.status = "DONE";
        fu.completedAt = new Date().toISOString();
        this.markDirty();
        return true;
    }

    // ─── 笔记 ───

    /** 添加工作笔记 */
    addNote(content: string, tags: string[] = [], relatedChatId?: string, expiresAt?: string): AgentNote {
        const note: AgentNote = {
            id: randomUUID(),
            content,
            tags,
            relatedChatId,
            expiresAt,
            createdAt: new Date().toISOString(),
        };
        this.state.notes.push(note);
        this.markDirty();
        log.debug("addNote", { noteId: note.id, content: content.slice(0, 50) });
        return note;
    }

    /** 删除工作笔记 */
    removeNote(noteId: string): boolean {
        const idx = this.state.notes.findIndex(n => n.id === noteId);
        if (idx === -1) return false;
        this.state.notes.splice(idx, 1);
        this.markDirty();
        return true;
    }

    /** 获取笔记（可按 chatId 过滤） */
    getNotes(chatId?: string): AgentNote[] {
        if (chatId) {
            return this.state.notes.filter(n => !n.relatedChatId || n.relatedChatId === chatId);
        }
        return [...this.state.notes];
    }

    /** 清理过期笔记，返回清理数量 */
    cleanExpiredNotes(): number {
        const now = new Date().toISOString();
        const before = this.state.notes.length;
        this.state.notes = this.state.notes.filter(n => !n.expiresAt || n.expiresAt > now);
        const removed = before - this.state.notes.length;
        if (removed > 0) this.markDirty();
        return removed;
    }

    // ─── 调度 (scheduler) ───

    /** 添加定时提醒 */
    addReminder(chatId: string, description: string, triggerAt: string, requestedBy?: string): SchedulerEvent {
        const event: SchedulerEvent = {
            id: randomUUID(),
            type: "reminder",
            chatId,
            description,
            triggerAt,
            requestedBy,
            createdAt: new Date().toISOString(),
            triggered: false,
        };
        this.state.schedulerEvents.push(event);
        this.markDirty();
        log.debug("addReminder", { id: event.id, chatId, triggerAt });
        return event;
    }

    /** 添加周期 cron 任务（自然语言任务描述） */
    addCron(chatId: string, description: string, cronExpr: string, taskDescription: string): SchedulerEvent {
        const event: SchedulerEvent = {
            id: randomUUID(),
            type: "cron",
            chatId,
            description,
            cronExpr,
            taskTemplate: taskDescription,
            createdAt: new Date().toISOString(),
        };
        this.state.schedulerEvents.push(event);
        this.markDirty();
        log.debug("addCron", { id: event.id, chatId, cronExpr });
        return event;
    }

    /** 取消调度事件 */
    cancelSchedulerEvent(id: string): boolean {
        const idx = this.state.schedulerEvents.findIndex(e => e.id === id);
        if (idx === -1) return false;
        this.state.schedulerEvents.splice(idx, 1);
        this.markDirty();
        log.debug("cancelSchedulerEvent", { id });
        return true;
    }

    /** 获取所有调度事件（可按 chatId 过滤） */
    getSchedulerEvents(chatId?: string): SchedulerEvent[] {
        if (chatId) {
            return this.state.schedulerEvents.filter(e => e.chatId === chatId);
        }
        return [...this.state.schedulerEvents];
    }

    /** 获取已到期的提醒（未触发的，triggerAt <= now） */
    getDueReminders(): SchedulerEvent[] {
        const now = new Date().toISOString();
        return this.state.schedulerEvents.filter(
            e => e.type === "reminder" && !e.triggered && e.triggerAt && e.triggerAt <= now
        );
    }

    /** 标记提醒为已触发 */
    markReminderTriggered(id: string): boolean {
        const event = this.state.schedulerEvents.find(e => e.id === id && e.type === "reminder");
        if (!event) return false;
        event.triggered = true;
        this.markDirty();
        return true;
    }

    /** 更新 cron 的 lastTriggeredAt */
    markCronTriggered(id: string): void {
        const event = this.state.schedulerEvents.find(e => e.id === id);
        if (event) {
            event.lastTriggeredAt = new Date().toISOString();
            this.markDirty();
        }
    }

    // ─── 持久化 ───

    /** 立即保存 */
    save(): void {
        try {
            const dir = dirname(this.config.filePath);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }
            writeFileSync(this.config.filePath, JSON.stringify(this.state, null, 2), "utf-8");
            this.dirty = false;
        } catch (err) {
            log.error("save: 失败", { error: String(err) });
        }
    }

    /** 释放（停止自动保存，保存当前状态） */
    dispose(): void {
        if (this.autoSaveTimer) {
            clearInterval(this.autoSaveTimer);
            this.autoSaveTimer = null;
        }
        if (this.dirty) this.save();
    }

    // ─── 内部 ───

    private markDirty(): void {
        this.dirty = true;
    }

    private load(): MainAgentGlobalState {
        if (!existsSync(this.config.filePath)) {
            return this.defaultState();
        }

        try {
            const raw = readFileSync(this.config.filePath, "utf-8");
            const parsed = JSON.parse(raw);
            log.info("load: 已恢复", { filePath: this.config.filePath });
            return this.validateState(parsed);
        } catch (err) {
            log.warn("load: 文件损坏，使用默认值", { error: String(err) });
            return this.defaultState();
        }
    }

    private validateState(raw: unknown): MainAgentGlobalState {
        const def = this.defaultState();
        if (!raw || typeof raw !== "object") return def;

        const obj = raw as Record<string, unknown>;
        return {
            lastActiveAt: typeof obj.lastActiveAt === "string" ? obj.lastActiveAt : def.lastActiveAt,
            taskList: Array.isArray(obj.taskList) ? obj.taskList : def.taskList,
            recentDecisions: Array.isArray(obj.recentDecisions) ? obj.recentDecisions : def.recentDecisions,
            pendingFollowups: Array.isArray(obj.pendingFollowups) ? obj.pendingFollowups : def.pendingFollowups,
            attentionSummary: typeof obj.attentionSummary === "string" ? obj.attentionSummary : def.attentionSummary,
            notes: Array.isArray(obj.notes) ? obj.notes : def.notes,
            schedulerEvents: Array.isArray(obj.schedulerEvents) ? obj.schedulerEvents : def.schedulerEvents,
        };
    }

    private defaultState(): MainAgentGlobalState {
        return {
            lastActiveAt: new Date().toISOString(),
            taskList: [],
            recentDecisions: [],
            pendingFollowups: [],
            attentionSummary: "",
            notes: [],
            schedulerEvents: [],
        };
    }
}
