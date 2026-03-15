/**
 * prompt-renderer.ts — Prompt 模板渲染系统
 *
 * 7 个结构化 prompt 注入点（subagent.md §12）：
 * ➊ MainAgent.AttentionPrompt — 主循环注意力切换
 * ➋ MainAgent.DecisionPrompt — 决策生成
 * ➌ Observer.TriagePrompt — 话题分类（Observer 端）   [复用已有]
 * ➍ Observer.EngagementPrompt — engagement 告警描述   [复用已有]
 * ➎ CodeAct.ExecutionPrompt — CodeAct 执行上下文
 * ➏ FastPath.ReplyPrompt — FastPath 快速回复
 * ➐ MainAgent.CallbackPrompt — 回调处理
 *
 * 模板以 .md 文件存放在 system-prompts/ 目录下。
 * 使用 Mustache-like 变量（{{variable}}）和条件块（{{#flag}}...{{/flag}}）。
 *
 * 参考设计：subagent.md §12, subtask.md S5.5
 */

import type { GroupContextPackage, TopicDigest, SubagentCallback } from "../subagent/types.js";
import type { GroupModel } from "../memory-v2/types.js";
import { createLogger } from "../core/logger.js";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const log = createLogger("prompt-renderer");

// ─── 模板文件映射 ───

/** Prompt 类型 → 文件名映射 */
const PROMPT_FILE_MAP: Record<string, string> = {
    ATTENTION: "subagent-attention.md",
    DECISION: "subagent-decision.md",
    EXECUTION: "subagent-execution.md",
    EXECUTION_TASK: "subagent-execution-task.md",
    FAST_PATH: "subagent-fast-path.md",
    CALLBACK: "subagent-callback.md",
};

export type PromptType = keyof typeof PROMPT_FILE_MAP;

// ─── 模板缓存 ───

const _templateCache = new Map<string, string>();
let _promptDir: string | null = null;

/**
 * 设置 prompt 模板目录（用于测试或自定义路径）
 */
export function setPromptDirectory(dir: string): void {
    _promptDir = dir;
    _templateCache.clear();
}

/**
 * 获取 prompt 模板目录
 * 默认为项目根目录下的 system-prompts/
 */
function getPromptDir(): string {
    if (_promptDir) return _promptDir;

    // 默认：从当前文件向上两级找到项目根目录
    try {
        const thisFile = fileURLToPath(import.meta.url);
        const projectRoot = join(dirname(thisFile), "..", "..");
        return join(projectRoot, "system-prompts");
    } catch {
        // fallback
        return "system-prompts";
    }
}

/**
 * 读取 prompt 模板文件（带缓存）
 */
export function loadTemplate(type: PromptType): string {
    const cached = _templateCache.get(type);
    if (cached) return cached;

    const filename = PROMPT_FILE_MAP[type];
    if (!filename) {
        throw new Error(`Unknown prompt type: ${type}`);
    }

    const filePath = join(getPromptDir(), filename);

    if (!existsSync(filePath)) {
        log.warn("loadTemplate: 文件不存在, 使用空模板", { type, filePath });
        return "";
    }

    const content = readFileSync(filePath, "utf-8");
    _templateCache.set(type, content);
    log.debug("loadTemplate: 已加载", { type, filePath, length: content.length });
    return content;
}

/**
 * 清除模板缓存（用于测试或热重载）
 */
export function clearTemplateCache(): void {
    _templateCache.clear();
}

/**
 * 渲染 prompt 模板
 *
 * 支持：
 * - {{variable}} — 简单变量替换
 * - {{#flag}}...{{/flag}} — 条件块（flag 为真时显示）
 */
export function renderPrompt(type: PromptType, variables: Record<string, unknown>): string {
    const template = loadTemplate(type);
    return renderTemplate(template, variables);
}

/**
 * 渲染任意模板字符串（用于外部自定义模板）
 */
export function renderTemplate(template: string, variables: Record<string, unknown>): string {
    let result = template;

    // 条件块处理：{{#flag}}content{{/flag}}
    result = result.replace(
        /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
        (_, flag: string, content: string) => {
            return variables[flag] ? content : "";
        }
    );

    // 变量替换：{{variable}}
    result = result.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
        const val = variables[key];
        if (val === undefined || val === null) return "";
        if (typeof val === "object") return JSON.stringify(val, null, 2);
        return String(val);
    });

    return result.trim();
}

/**
 * 从 GroupContextPackage 构建 ATTENTION prompt 的变量
 */
export function buildAttentionVariables(
    pkg: GroupContextPackage,
    newMessageCount: number,
    options?: {
        persona?: string;
        lastAttendedAt?: string | null;
        timeSinceLastAttend?: string;
        stickinessLevel?: string;
        priorityMultiplier?: number;
        tonePreset?: string;
        callbacks?: SubagentCallback[];
        fastPathHistory?: string;
        alertReason?: string;
        messages?: string;
        suggestedReplyMode?: string;
    },
): Record<string, unknown> {
    const opts = options ?? {};
    const hasMessages = !!opts.messages;

    return {
        chatId: pkg.chatId,
        depth: pkg.depth,
        snapshotTimestamp: pkg.snapshotTimestamp,
        engagementScore: pkg.engagementScore,
        newMessageCount,
        topicCount: pkg.topicDigests.length,
        topicDigests: formatTopicDigests(pkg.topicDigests),

        // Persona
        persona: opts.persona ?? "",

        // Timing
        lastAttendedAt: opts.lastAttendedAt ?? "无记录",
        timeSinceLastAttend: opts.timeSinceLastAttend ?? "未知",

        // Stickiness
        stickinessLevel: opts.stickinessLevel ?? "STRANGER",
        priorityMultiplier: opts.priorityMultiplier ?? 0.2,
        tonePreset: opts.tonePreset ?? "礼貌得体",

        // Group model
        groupModel: !!pkg.groupModel,
        chatTitle: pkg.groupModel?.chatTitle ?? "",
        description: pkg.groupModel?.description ?? "",
        avgMessagesPerDay: pkg.groupModel?.avgMessagesPerDay ?? 0,
        engagementLevel: pkg.groupModel?.engagementLevel ?? "",

        // Callbacks
        hasCallbacks: !!opts.callbacks?.length,
        callbacks: opts.callbacks?.map(cb => `- [${cb.status}] ${cb.summary}`).join("\n") ?? "",

        // Messages (L2+)
        hasMessages,
        noMessages: !hasMessages,
        messages: opts.messages ?? "",

        // Alert
        hasAlert: !!opts.alertReason,
        alertReason: opts.alertReason ?? "",

        // FastPath history
        hasFastPathHistory: !!opts.fastPathHistory,
        fastPathHistory: opts.fastPathHistory ?? "",

        // Decision hint
        suggestedReplyMode: opts.suggestedReplyMode ?? "NONE",
    };
}


/**
 * 格式化 TopicDigest 列表为可读字符串
 */
function formatTopicDigests(digests: TopicDigest[]): string {
    if (digests.length === 0) return "(无活跃话题)";

    return digests.map((d, i) =>
        `${i + 1}. [${d.state}] ${d.label} (${d.messageCount}条消息)\n   摘要: ${d.summary}\n   关键词: ${d.keywords.join(", ")}`
    ).join("\n");
}
