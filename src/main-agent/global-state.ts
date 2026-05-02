/**
 * global-state.ts — 主 Agent 全局状态管理
 *
 * 持久化存储主 Agent 的全局状态：
 * - scheduler 事件
 * - Meta-CodeAct 全局备忘录
 * - Session digests
 * - Accumulator 信号池
 * - 唤醒条件
 *
 * 使用 JSON 文件持久化，支持损坏恢复。
 *
 * 参考设计：subagent.md §9, subtask.md S6
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
    MainAgentGlobalState,
    SchedulerEvent,
    MemoEntry,
    MetaSessionHistoryEntry,
    SessionDigestEntry,
    SignalPoolItem,
    WakeCondition,
    WakeConditionRecord,
} from "../subagent/types.js";
import { createLogger } from "../core/logger.js";
import { randomUUID } from "node:crypto";
import { trimMetaSessionHistoryWindow } from "./meta-history-retention.js";

const log = createLogger("global-state");

/** GlobalState 配置 */
export interface GlobalStateConfig {
    /** 持久化文件路径。默认 workspace/global-state.json */
    filePath: string;
    /** 自动保存间隔 (ms)。0 = 不自动保存。默认 30000 */
    autoSaveInterval: number;
}

const DEFAULT_CONFIG: GlobalStateConfig = {
    filePath: "workspace/global-state.json",
    autoSaveInterval: 30000,
};

const MAX_SESSION_DIGESTS = 10;

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

    // ─── 调度 (scheduler) ───

    /** 添加定时提醒 */
    addReminder(
        chatId: string,
        description: string,
        triggerAt: string,
        requestedBy?: string,
        options?: { bindingId?: string; name?: string; callback?: string; data?: unknown },
    ): SchedulerEvent {
        const event: SchedulerEvent = {
            id: randomUUID(),
            type: "reminder",
            chatId,
            bindingId: options?.bindingId,
            name: options?.name,
            description,
            callback: options?.callback,
            data: options?.data,
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
    addCron(
        chatId: string,
        description: string,
        cronExpr: string,
        taskDescription: string,
        options?: { bindingId?: string; name?: string; callback?: string; data?: unknown },
    ): SchedulerEvent {
        const event: SchedulerEvent = {
            id: randomUUID(),
            type: "cron",
            chatId,
            bindingId: options?.bindingId,
            name: options?.name,
            description,
            callback: options?.callback,
            data: options?.data,
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

    // ─── Meta-CodeAct 状态 ───

    memoSet(key: string, value: unknown, ttlMinutes?: number): void {
        const createdAt = new Date().toISOString();
        const expiresAt = typeof ttlMinutes === "number" && ttlMinutes > 0
            ? new Date(Date.now() + ttlMinutes * 60_000).toISOString()
            : undefined;
        const memo: MemoEntry = { key, value, createdAt, expiresAt };
        const existingIndex = this.state.memos.findIndex(item => item.key === key);
        if (existingIndex >= 0) {
            this.state.memos.splice(existingIndex, 1, memo);
        } else {
            this.state.memos.push(memo);
        }
        this.markDirty();
    }

    memoGet(key: string): unknown | null {
        this.cleanExpiredMemos();
        const memo = this.state.memos.find(item => item.key === key);
        return memo ? memo.value : null;
    }

    memoDelete(key: string): void {
        const index = this.state.memos.findIndex(item => item.key === key);
        if (index === -1) return;
        this.state.memos.splice(index, 1);
        this.markDirty();
    }

    memoList(): Array<{ key: string; value: unknown; expiresAt?: string }> {
        this.cleanExpiredMemos();
        return this.state.memos.map(({ key, value, expiresAt }) => ({ key, value, expiresAt }));
    }

    cleanExpiredMemos(): number {
        const now = new Date().toISOString();
        const before = this.state.memos.length;
        this.state.memos = this.state.memos.filter(item => !item.expiresAt || item.expiresAt > now);
        const removed = before - this.state.memos.length;
        if (removed > 0) this.markDirty();
        return removed;
    }

    addSessionDigest(content: string): void {
        const entry: SessionDigestEntry = {
            content,
            createdAt: new Date().toISOString(),
        };
        this.state.sessionDigests.push(entry);
        while (this.state.sessionDigests.length > MAX_SESSION_DIGESTS) {
            this.state.sessionDigests.shift();
        }
        this.markDirty();
    }

    getSessionDigests(): SessionDigestEntry[] {
        return [...this.state.sessionDigests];
    }

    appendMetaSessionHistory(
        messages: Array<Pick<MetaSessionHistoryEntry, "role" | "content"> & Partial<Pick<MetaSessionHistoryEntry, "timestamp">>>,
    ): void {
        let appended = 0;

        for (const message of messages) {
            if (!message || (message.role !== "assistant" && message.role !== "user")) {
                continue;
            }

            const content = String(message.content ?? "").trim();
            if (!content) {
                continue;
            }

            this.state.metaSessionHistory.push({
                role: message.role,
                content,
                timestamp: message.timestamp ?? new Date().toISOString(),
            });
            appended += 1;
        }

        trimMetaSessionHistoryWindow(this.state.metaSessionHistory);

        if (appended > 0) {
            this.markDirty();
        }
    }

    getMetaSessionHistory(): MetaSessionHistoryEntry[] {
        return [...this.state.metaSessionHistory];
    }

    getSignalPool(): SignalPoolItem[] {
        return [...this.state.signalPool];
    }

    setSignalPool(items: SignalPoolItem[]): void {
        this.state.signalPool = [...items];
        this.markDirty();
    }

    addWakeCondition(condition: WakeCondition): string {
        const wakeCondition: WakeConditionRecord = {
            id: randomUUID(),
            condition,
            registeredAt: new Date().toISOString(),
        };
        this.state.wakeConditions.push(wakeCondition);
        this.markDirty();
        return wakeCondition.id;
    }

    removeWakeCondition(id: string): boolean {
        const index = this.state.wakeConditions.findIndex(item => item.id === id);
        if (index === -1) return false;
        this.state.wakeConditions.splice(index, 1);
        this.markDirty();
        return true;
    }

    getWakeConditions(): WakeConditionRecord[] {
        return [...this.state.wakeConditions];
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
            schedulerEvents: Array.isArray(obj.schedulerEvents) ? obj.schedulerEvents : def.schedulerEvents,
            memos: Array.isArray(obj.memos) ? obj.memos as MemoEntry[] : def.memos,
            sessionDigests: Array.isArray(obj.sessionDigests) ? obj.sessionDigests as SessionDigestEntry[] : def.sessionDigests,
            metaSessionHistory: Array.isArray(obj.metaSessionHistory) ? obj.metaSessionHistory as MetaSessionHistoryEntry[] : def.metaSessionHistory,
            signalPool: Array.isArray(obj.signalPool) ? obj.signalPool as SignalPoolItem[] : def.signalPool,
            wakeConditions: Array.isArray(obj.wakeConditions) ? obj.wakeConditions as WakeConditionRecord[] : def.wakeConditions,
        };
    }

    private defaultState(): MainAgentGlobalState {
        return {
            schedulerEvents: [],
            memos: [],
            sessionDigests: [],
            metaSessionHistory: [],
            signalPool: [],
            wakeConditions: [],
        };
    }
}
