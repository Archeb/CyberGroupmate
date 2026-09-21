/**
 * harness/dreaming-context.ts — 做梦上下文（background-dreaming.md）生成器
 *
 * 取代原先由 reflection 产出的「做梦方向感」。每次做梦启动前，把本周期内
 * （上次做梦以来）真正派发执行过的 subagent 任务按 chatId 分组喂进去，并附上
 * 每个群的聊天画像和活跃参与者画像，让做梦时既知道自己做了什么，也知道群关系。
 *
 * 设计要点：
 * - post-task-* 系列任务只保留 summary 和 sentMessages（其余字段对做梦无意义）
 * - 任务总数超过 maxTasks（默认 100）时随机抽样，避免上下文爆炸
 * - chatId 通过 groupModel resolve 成可读的 chatTitle
 *
 * @see harness/manager.ts（调用方）、harness/prompt.ts（消费 background-dreaming.md）
 */

import { getGroupModelKey, getDunbarTierLabel } from "../core/chat-id.js";
import { deriveChatType } from "../context-engine/prompt-renderer-utils.js";
import { formatTsForPrompt } from "../core/timezone.js";
import type { DispatchedSubagentTaskRecord } from "../subagent/types.js";
import type { GroupModel, PersonGroupProfile, PersonIdentity, PersonProfile } from "../memory-v2/types.js";

/** 做梦上下文需要的只读记忆视图 */
export interface DreamingMemoryView {
    getGroupModel(chatId: string): GroupModel | null;
    getProfilesForChat(chatId: string): PersonGroupProfile[];
    getPersonIdentity(userId: string): PersonIdentity | null;
    getPersonProfile(userId: string): PersonProfile | null;
}

export interface DreamingContextDeps {
    /** 返回当前持久化的全部已派发任务（任意顺序均可，内部会再排序） */
    listTasks: () => DispatchedSubagentTaskRecord[];
    memory: DreamingMemoryView;
    /** 只纳入 createdAt >= sinceTs（ms）的任务；null 表示不限（全部） */
    sinceTs?: number | null;
    /** 任务数量上限，超过则随机抽样。默认 100 */
    maxTasks?: number;
    /** 每个群展示的活跃参与者上限。默认 12 */
    maxParticipants?: number;
    /** 最近的全局 session digests / consciousness memory。 */
    sessionDigests?: Array<{
        createdAt: string;
        content: string;
        kind?: string;
        actorType?: string;
        actorId?: string;
        sourceChatId?: string | null;
        sourceChatTitle?: string | null;
        targetChatId?: string | null;
        taskId?: string | null;
        runId?: string | null;
    }>;
}

const DEFAULT_MAX_TASKS = 100;
const DEFAULT_MAX_PARTICIPANTS = 12;
// 摘要裁剪阈值：这份文件会被做梦 agent 整体读入并随每轮工具调用重复携带，
// 过长的 turn-by-turn 思考流水账会以「长度 × 轮数」放大成本。只保留「做了什么」的密度。
const SUMMARY_CLIP = 400;
// 全局意识流 digest 单条截断：meta 播报常携带全量「在等/全轨」跟踪状态，相邻条目高度重复
const DIGEST_CLIP = 320;

/**
 * 构建 background-dreaming.md 的完整内容。无可用任务时返回 null。
 */
export function buildDreamingDigest(deps: DreamingContextDeps): string | null {
    const maxTasks = deps.maxTasks ?? DEFAULT_MAX_TASKS;
    const maxParticipants = deps.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS;
    const sinceTs = deps.sinceTs ?? null;

    const all = deps.listTasks();
    let tasks = all.filter((task) => {
        if (!sinceTs) return true;
        const created = Date.parse(task.createdAt);
        return Number.isFinite(created) ? created >= sinceTs : true;
    });

    if (tasks.length === 0 && !(deps.sessionDigests?.length)) {
        return null;
    }

    const totalInWindow = tasks.length;
    let sampled = false;
    if (tasks.length > maxTasks) {
        tasks = randomSample(tasks, maxTasks);
        sampled = true;
    }

    // 按 chatId 分组
    const groups = new Map<string, DispatchedSubagentTaskRecord[]>();
    for (const task of tasks) {
        const arr = groups.get(task.chatId) ?? [];
        arr.push(task);
        groups.set(task.chatId, arr);
    }

    // 组内按 createdAt 升序（时间顺序读起来像回忆），组间按任务数降序
    const orderedGroups = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

    const sections: string[] = [];
    sections.push(buildHeader(totalInWindow, sampled, maxTasks, sinceTs));
    const digestSection = renderSessionDigests(deps.sessionDigests ?? []);
    if (digestSection) {
        sections.push(digestSection);
    }

    for (const [chatId, groupTasks] of orderedGroups) {
        groupTasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        sections.push(renderChatGroup(chatId, groupTasks, deps.memory, maxParticipants));
    }

    return sections.join("\n\n---\n\n");
}

function renderSessionDigests(digests: NonNullable<DreamingContextDeps["sessionDigests"]>): string | null {
    if (digests.length === 0) return null;
    const lines = ["# 最近全局意识流 / Session Digests"];
    for (const digest of digests.slice(-30)) {
        const source = [
            digest.actorType,
            digest.actorId,
            digest.sourceChatTitle || digest.sourceChatId,
            digest.kind,
        ].filter(Boolean).join(" / ");
        const refs = [
            digest.taskId ? `task=${digest.taskId}` : "",
            digest.runId ? `run=${digest.runId}` : "",
            digest.targetChatId ? `target=${digest.targetChatId}` : "",
        ].filter(Boolean).join(", ");
        lines.push(`- [${formatTsForPrompt(digest.createdAt)}]${source ? ` [${source}]` : ""}${refs ? ` (${refs})` : ""} ${clip(digest.content, DIGEST_CLIP)}`);
    }
    return lines.join("\n");
}

function buildHeader(total: number, sampled: boolean, maxTasks: number, sinceTs: number | null): string {
    const windowDesc = sinceTs
        ? `自上次做梦（${formatTsForPrompt(new Date(sinceTs).toISOString())}）以来`
        : "目前留存范围内";
    const countDesc = sampled
        ? `本周期共 ${total} 个任务，随机抽取了 ${maxTasks} 个`
        : `本周期共 ${total} 个任务`;
    return [
        "# 本周期回顾",
        "",
        `这是${windowDesc}，你（通过 subagent）在各个群聊/私聊里实际做过的事，以及这些聊天的关系画像。`,
        "读它像回忆今天发生过什么：你接住了谁、说了什么、群里是什么氛围。可以作为做梦的起点，但不用被它牵着走。",
        "",
        "下面只是骨架——某件事让你在意、好奇或想多了解时，主动用 MCP 工具把上下文挖出来，不要只凭这里的片段下结论：",
        "- `conversation_messages`(chatId + 该任务发生的时间段，配合 before/after) / `conversation_query`(按人、关键词、时间检索)：读当时群里到底发生了什么。每个分组标题下都有 `chatId`，发送记录里带 `msg#<id>` 可定位具体消息。",
        "- `memory_resolvePerson` / `memory_getPersonDossier` / `memory_searchEntities`：深挖某个人的画像、关系和历史。",
        "- `session_digests`：拉某个群更完整的回合摘要。",
        "",
        `> ${countDesc}，按聊天分组。`,
    ].join("\n");
}

function renderChatGroup(
    chatId: string,
    tasks: DispatchedSubagentTaskRecord[],
    memory: DreamingMemoryView,
    maxParticipants: number,
): string {
    const groupModel = safe(() => memory.getGroupModel(getGroupModelKey(chatId)));
    const chatTitle = groupModel?.chatTitle?.trim() || chatId;
    const chatType = deriveChatType(groupModel?.isDirectMessage);

    const lines: string[] = [];
    lines.push(`## ${chatTitle} [${chatType}]`);
    lines.push(`<chatId: ${chatId}>`);

    const profileSection = renderGroupModel(groupModel);
    if (profileSection) {
        lines.push("", profileSection);
    }

    const participants = renderParticipants(chatId, memory, maxParticipants);
    if (participants) {
        lines.push("", participants);
    }

    lines.push("", renderTasks(tasks));

    return lines.join("\n");
}

function renderGroupModel(groupModel: GroupModel | null): string | null {
    if (!groupModel) return null;
    const rows: Array<[string, string]> = [
        ["描述", text(groupModel.description)],
        ["主要语言", text(groupModel.dominantLanguage)],
        ["当前 agent 角色", text(groupModel.agentRole)],
        ["活跃度", text(groupModel.engagementLevel)],
        ["日均消息量", Number.isFinite(groupModel.avgMessagesPerDay) ? String(groupModel.avgMessagesPerDay) : ""],
        ["交流规范", list(groupModel.communicationNorms)],
        ["热点话题", list(groupModel.hotTopics)],
        ["不宜讨论", list(groupModel.tabooTopics)],
        ["最近反馈", text(groupModel.recentFeedback)],
    ];
    const body = rows
        .filter(([, value]) => value && value !== "无")
        .map(([label, value]) => `- ${label}: ${value}`);
    if (body.length === 0) return null;
    return ["### 聊天画像", ...body].join("\n");
}

function renderParticipants(
    chatId: string,
    memory: DreamingMemoryView,
    maxParticipants: number,
): string | null {
    const profiles = safe(() => memory.getProfilesForChat(chatId)) ?? [];
    if (profiles.length === 0) return null;

    const ranked = [...profiles]
        .sort((a, b) => (b.affinityScore - a.affinityScore) || (b.messageCount - a.messageCount))
        .slice(0, maxParticipants);

    const lines = ranked.map((profile) => formatParticipant(profile, memory));
    return ["### 活跃参与者", ...lines].join("\n");
}

function formatParticipant(profile: PersonGroupProfile, memory: DreamingMemoryView): string {
    const identity = safe(() => memory.getPersonIdentity(profile.userId));
    const global = safe(() => memory.getPersonProfile(profile.userId));
    const name = identity?.displayName?.trim() || profile.userId;
    const tier = `${getDunbarTierLabel(profile.dunbarTier)}`;
    const rapport = Number.isFinite(profile.affinityScore) ? `好感 ${Math.round(profile.affinityScore)}` : "";

    const head = [`- ${name}`, `(${[tier, rapport].filter(Boolean).join(", ")})`].join(" ");

    const detail: string[] = [];
    const relation = global?.relationToAgent?.trim() || profile.relationToAgent?.trim();
    if (relation) detail.push(`关系: ${clip(relation, 160)}`);
    const interests = [...new Set([...(global?.interests ?? []), ...profile.interests])].slice(0, 6);
    if (interests.length > 0) detail.push(`兴趣: ${interests.join("、")}`);
    const style = global?.communicationStyle?.trim() || profile.communicationStyle?.trim();
    if (style) detail.push(`风格: ${clip(style, 120)}`);

    return detail.length > 0 ? `${head}\n  ${detail.join(" | ")}` : head;
}

function renderTasks(tasks: DispatchedSubagentTaskRecord[]): string {
    const lines: string[] = [`### 本周期任务 (${tasks.length} 条)`];
    let i = 1;
    for (const task of tasks) {
        lines.push("", formatTask(task, i++));
    }
    return lines.join("\n");
}

function formatTask(task: DispatchedSubagentTaskRecord, index: number): string {
    const isPostTask = task.taskId.startsWith("post-task-");
    const lines: string[] = [];

    if (isPostTask) {
        // post-task 系列只保留 summary 和 sentMessages
        lines.push(`${index}. [post-task] ${formatTsForPrompt(task.createdAt)}`);
    } else {
        const header = [
            `${index}.`,
            `[${task.status}]`,
            formatTsForPrompt(task.createdAt),
        ].join(" ");
        lines.push(header);
        if (task.contentDirection?.trim()) {
            lines.push(`   方向: ${clip(task.contentDirection.trim(), 300)}`);
        }
    }

    if (task.summary?.trim()) {
        lines.push(`   思考: ${clip(task.summary.trim(), SUMMARY_CLIP)}`);
    }

    const sent = (task.sentMessages ?? [])
        .filter((msg) => msg.text)
        .map((msg) => `"${msg.text}"${msg.messageId ? ` (msg#${msg.messageId})` : ""}`);
    if (sent.length > 0) {
        lines.push(`   发送: ${sent.join(" / ")}`);
    } else if (!isPostTask && task.error?.trim()) {
        lines.push(`   错误: ${clip(task.error.trim(), 200)}`);
    }

    return lines.join("\n");
}

// ─── 小工具 ───

/** Fisher-Yates 部分洗牌抽样 n 个元素 */
function randomSample<T>(items: T[], n: number): T[] {
    const arr = [...items];
    const count = Math.min(n, arr.length);
    for (let i = 0; i < count; i++) {
        const j = i + Math.floor(Math.random() * (arr.length - i));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, count);
}

function text(value: string | undefined | null): string {
    return value?.trim() ?? "";
}

function list(values: string[] | undefined | null): string {
    return values && values.length > 0 ? values.join("、") : "";
}

function clip(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, max)}…` : value;
}

function safe<T>(fn: () => T): T | null {
    try {
        return fn();
    } catch {
        return null;
    }
}
