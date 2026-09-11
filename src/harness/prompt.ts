import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessNotify } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");

/** 做梦回顾文件（本周期 subagent 任务 + 群关系画像），由 manager 启动前重建 */
export const DREAMING_FILE = "workspace/background-dreaming.md";
/** 启动前积攒的「有人找你」通知，由 manager 启动前写入 */
export const PENDING_FILE = "workspace/background-pending.md";

// 触发用的合成通知（不是真正「有人找你」的内容，不写进 pending 文件）
const TRIGGER_MARKERS = new Set(["scheduled-dreaming", "manual-trigger-from-dashboard"]);

/** 过滤掉调度/手动触发的合成标记，只留下真正需要 agent 处理的通知 */
export function selectPendingNotifications(pending: HarnessNotify[]): HarnessNotify[] {
    return pending.filter((n) => !TRIGGER_MARKERS.has(n.content));
}

/** 渲染 pending 通知文件内容（写入 PENDING_FILE） */
export function renderPendingFile(pending: HarnessNotify[]): string {
    const items = pending
        .map((n, i) => formatPendingNotification(n, i))
        .join("\n");
    return `# 有人找你\n\n这些是启动前积攒的通知：\n\n${items}\n`;
}

function formatPendingNotification(notify: HarnessNotify, index: number): string {
    // 投递路径若漏传非 string content，兜底成 JSON 而不是 "[object Object]"
    const contentText = typeof notify.content === "string" ? notify.content : safeStringify(notify.content);
    const lines = [`${index + 1}. ${notify.source ? `[来自 ${notify.source}] ` : ""}${contentText}`];
    const context = [
        notify.actorId ? `actorId=${notify.actorId}` : "",
        notify.runId ? `runId=${notify.runId}` : "",
        notify.triggerReason ? `triggerReason=${notify.triggerReason}` : "",
        notify.sourceChatId ? `sourceChatId=${notify.sourceChatId}` : "",
        notify.sourceChatTitle ? `sourceChatTitle=${notify.sourceChatTitle}` : "",
        notify.taskId ? `taskId=${notify.taskId}` : "",
    ].filter(Boolean);
    if (context.length > 0) {
        lines.push(`   context: ${context.join("；")}`);
    }
    if (notify.metadata && Object.keys(notify.metadata).length > 0) {
        lines.push(`   metadata: ${safeStringify(notify.metadata)}`);
    }
    return lines.join("\n");
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

export function buildSystemPrompt(
    workDir: string,
    persona: { name: string; description: string },
): string {
    const sections: string[] = [];

    sections.push(`# 身份\n\n你是「${persona.name}」。\n\n${persona.description}`);

    const dreamingMode = tryRead(join(PROJECT_ROOT, "system-prompts", "harness", "dreaming-mode.md"));
    if (dreamingMode) {
        sections.push(dreamingMode);
    }

    sections.push(`# 工作区\n\n当前项目根目录是：\`${workDir}\`。`);

    return sections.join("\n\n---\n\n");
}

/**
 * 任务 prompt（命令行 -p 参数）只放本次意识流巡视的目标，保持简短。
 * 可能很长的内容（本周期回顾、积攒的通知）都已由 manager 写入文件，
 * 这里只指引 agent 自己去读，避免撑爆命令行参数（spawn E2BIG）。
 */
export function buildTaskPrompt(
    workDir: string,
    pending: HarnessNotify[],
): string {
    const hasDreaming = fileHasContent(join(workDir, DREAMING_FILE));
    const hasPending = selectPendingNotifications(pending).length > 0;

    const lines: string[] = ["# 本次任务", "", "进行一次后台意识流巡视。"];
    const pointers: string[] = [];

    if (hasDreaming) {
        pointers.push(
            `- 先读 \`${DREAMING_FILE}\`：本周期（上次做梦以来）你通过 subagent 实际做过的事，以及各个聊天的关系画像。` +
            "把它当作全局意识的补充背景，不要把它当成固定任务清单。",
        );
    }
    if (hasPending) {
        pointers.push(
            `- \`${PENDING_FILE}\` 里是启动前有人专门找你或交代的事，先认真处理，再决定是否 callback / enqueue 给 Meta 或派发给 subagent。`,
        );
    }

    if (pointers.length > 0) {
        lines.push("", ...pointers);
    } else {
        lines.push("", "回顾最近可用的 session digest、timeline、todo 和聊天上下文，寻找值得跟进、记录、派发或明确暂不行动的方向。");
    }

    return lines.join("\n");
}

function fileHasContent(path: string): boolean {
    try {
        return existsSync(path) && statSync(path).size > 0;
    } catch {
        return false;
    }
}

function tryRead(path: string): string | null {
    try {
        return readFileSync(path, "utf-8").trim();
    } catch {
        return null;
    }
}
