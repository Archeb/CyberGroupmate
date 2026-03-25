/**
 * tests/helpers/test-db.ts — 测试数据库工具
 *
 * 提供 MemoryStoreV2 测试实例的创建、清理和种子数据填充。
 * 同时用于自动化测试和手动 dry-run 验证。
 */

import { unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { MemoryStoreV2 } from "../../src/memory-v2/index.js";

/** 测试数据库存放目录 */
const TEST_DB_DIR = "/tmp/cybergroupmate-test";

/** 确保测试目录存在 */
function ensureTestDir(): void {
    if (!existsSync(TEST_DB_DIR)) {
        mkdirSync(TEST_DB_DIR, { recursive: true });
    }
}

/**
 * 创建一个测试用 MemoryStoreV2 实例
 * @param name - 数据库名称标识（自动拼接路径和 .db 后缀）
 */
export function createTestMemory(name: string): MemoryStoreV2 {
    ensureTestDir();
    const dbPath = join(TEST_DB_DIR, `${name}.db`);
    // 清理残留
    if (existsSync(dbPath)) unlinkSync(dbPath);
    if (existsSync(dbPath + "-wal")) unlinkSync(dbPath + "-wal");
    if (existsSync(dbPath + "-shm")) unlinkSync(dbPath + "-shm");
    return new MemoryStoreV2(dbPath);
}

/**
 * 获取测试数据库的文件路径
 */
export function testDbPath(name: string): string {
    return join(TEST_DB_DIR, `${name}.db`);
}

/**
 * 关闭并删除测试数据库
 */
export function cleanupTestMemory(memory: MemoryStoreV2, name: string): void {
    try { memory.close(); } catch { /* ignore */ }
    const dbPath = join(TEST_DB_DIR, `${name}.db`);
    for (const suffix of ["", "-wal", "-shm"]) {
        try { if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }
}

/**
 * 向测试数据库填充种子数据（用于 dry-run 手动验证）
 *
 * 创建完整的样本数据集：
 * - 3 个话题（含不同状态：进行中、已结束、ENGAGED）
 * - 20 条消息日志
 * - 5 条核心事实
 * - 3 个用户身份
 * - 3 个群内画像
 * - 1 个群组画像
 */
export function seedTestData(memory: MemoryStoreV2, chatId = "-100001"): void {
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 3600_000);
    const dayAgo = new Date(now.getTime() - 86400_000);

    // ─── 用户身份 ───
    memory.upsertPersonIdentity("111", {
        displayName: "alice",
        aliases: ["Alice", "爱丽丝"],
        lastSeenAt: now.toISOString(),
    });
    memory.upsertPersonIdentity("222", {
        displayName: "bob",
        aliases: ["Bob"],
        lastSeenAt: hourAgo.toISOString(),
    });
    memory.upsertPersonIdentity("333", {
        displayName: "carol",
        aliases: ["Carol"],
        lastSeenAt: dayAgo.toISOString(),
    });

    // ─── 群组画像 ───
    memory.upsertGroupModel(chatId, {
        chatTitle: "测试群组",
        description: "用于 dry-run 测试的模拟群组",
        dominantLanguage: "zh",
        activeMembers: 3,
        avgMessagesPerDay: 50,
        agentRole: "知识助手",
        engagementLevel: "medium",
        hotTopics: ["京都旅行", "编程"],
    });

    // ─── 群内画像 ───
    memory.upsertPersonGroupProfile("111", chatId, {
        dunbarTier: 1,
        dunbarReason: "核心活跃用户",
        traits: ["热情", "好奇心强"],
        interests: ["旅行", "日本文化"],
        communicationStyle: "多用表情，喜欢追问细节",
        messageCount: 120,
    });
    memory.upsertPersonGroupProfile("222", chatId, {
        dunbarTier: 2,
        traits: ["冷静", "技术型"],
        interests: ["编程", "开源"],
        messageCount: 80,
    });
    memory.upsertPersonGroupProfile("333", chatId, {
        dunbarTier: 3,
        traits: ["安静"],
        interests: ["动漫"],
        messageCount: 15,
    });

    // ─── 话题 ───
    memory.upsertTopic("topic_kyoto", {
        chatId,
        label: "京都旅行攻略",
        summary: "讨论京都岚山竹林和交通方式，alice 问如何从大阪去京都",
        keyPoints: ["坐阪急到桂站转岚电", "竹林早上去人少"],
        keywords: ["京都", "岚山", "交通"],
        participants: ["111", "222"],
        messageRange: { firstMessageId: 100, lastMessageId: 115, count: 16 },
        startedAt: hourAgo.toISOString(),
        sentiment: "positive",
    });

    memory.upsertTopic("topic_code", {
        chatId,
        label: "Python 错误调试",
        summary: "bob 遇到 TypeError，alice 帮忙排查是类型转换问题",
        keyPoints: ["TypeError: cannot convert", "需要用 str()"],
        keywords: ["Python", "TypeError", "调试"],
        participants: ["222", "111"],
        messageRange: { firstMessageId: 120, lastMessageId: 130, count: 11 },
        startedAt: new Date(hourAgo.getTime() + 1800_000).toISOString(),
        sentiment: "neutral",
    });

    memory.upsertTopic("topic_anime", {
        chatId,
        label: "新番推荐",
        summary: "carol 推荐了几部新番，大家讨论剧情",
        keyPoints: ["葬送的芙莉莲很好看"],
        keywords: ["动漫", "新番", "芙莉莲"],
        participants: ["333", "111"],
        messageRange: { firstMessageId: 135, lastMessageId: 145, count: 11 },
        startedAt: dayAgo.toISOString(),
        endedAt: new Date(dayAgo.getTime() + 3600_000).toISOString(),
        sentiment: "positive",
    });

    // ─── 消息日志 ───
    const messages = [
        // 京都话题
        { messageId: "100", chatId, userId: "111", displayName: "alice", text: "有人去过京都吗？想问问交通", timestamp: hourAgo.toISOString() },
        { messageId: "101", chatId, userId: "222", displayName: "bob", text: "去过！坐阪急到桂站转岚电最方便", timestamp: new Date(hourAgo.getTime() + 60_000).toISOString() },
        { messageId: "102", chatId, userId: "111", displayName: "alice", text: "岚山竹林什么时候去比较好？", replyToMessageId: "101", timestamp: new Date(hourAgo.getTime() + 120_000).toISOString() },
        { messageId: "103", chatId, userId: "222", displayName: "bob", text: "早上去人少，下午全是旅行团", timestamp: new Date(hourAgo.getTime() + 180_000).toISOString() },
        { messageId: "104", chatId, userId: "111", displayName: "alice", text: "好的谢谢！", timestamp: new Date(hourAgo.getTime() + 240_000).toISOString() },
        // Python 话题
        { messageId: "120", chatId, userId: "222", displayName: "bob", text: "遇到一个 Python TypeError 不知道怎么解决", timestamp: new Date(hourAgo.getTime() + 1800_000).toISOString() },
        { messageId: "121", chatId, userId: "111", displayName: "alice", text: "什么 error message？贴一下", timestamp: new Date(hourAgo.getTime() + 1860_000).toISOString() },
        { messageId: "122", chatId, userId: "222", displayName: "bob", text: "TypeError: cannot convert 'int' object to str implicitly", timestamp: new Date(hourAgo.getTime() + 1920_000).toISOString() },
        { messageId: "123", chatId, userId: "111", displayName: "alice", text: "用 str() 包一下就行", timestamp: new Date(hourAgo.getTime() + 1980_000).toISOString() },
        // 新番话题
        { messageId: "135", chatId, userId: "333", displayName: "carol", text: "这季新番大家看了吗", timestamp: dayAgo.toISOString() },
        { messageId: "136", chatId, userId: "111", displayName: "alice", text: "葬送的芙莉莲超好看！", timestamp: new Date(dayAgo.getTime() + 60_000).toISOString() },
        { messageId: "137", chatId, userId: "333", displayName: "carol", text: "对对！画面太精致了", timestamp: new Date(dayAgo.getTime() + 120_000).toISOString() },
    ];
    memory.storeMessageBatch(messages);

    // ─── 核心事实 ───
    memory.storeFact("111", "alice 喜欢吃拉面", "preference");
    memory.storeFact("111", "alice 是前端程序员", "biographical");
    memory.storeFact("222", "bob 擅长 Python 和 Rust", "biographical");
    memory.storeFact("333", "carol 喜欢看动漫，特别是新番", "preference");
    memory.storeFact("-100001", "群里经常讨论旅行和编程", "general");
}
