#!/usr/bin/env npx tsx
/**
 * cli.ts — CyberGroupmate CLI 调试工具
 *
 * 提供子命令用于手动测试各组件：
 *   npx tsx src/cli.ts sandbox    — 交互式 sandbox REPL
 *   npx tsx src/cli.ts notify     — 手动推送一条通知
 *   npx tsx src/cli.ts memory     — 交互式 memory 查询
 *   npx tsx src/cli.ts config     — 检查配置加载结果
 *   npx tsx src/cli.ts status     — 查看 agent 状态
 */

import { createInterface } from "node:readline";
import { Sandbox } from "./sandbox/sandbox.js";
import { NotificationCenter } from "./event/notification-center.js";
import { MemoryStoreV2 } from "./memory-v2/index.js";
import { createMemoryStore } from "./core/memory-factory.js";
import { loadConfig, resolveComponentProfiles, resolveEmbeddingConfig } from "./core/config.js";
import { createLogger } from "./core/logger.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";


const log = createLogger("cli");
const DATA_DIR = "workspace";

// ─── 子命令 ───

/**
 * sandbox — 交互式 Sandbox REPL
 *
 * 启动 sandbox worker，然后进入 REPL 循环。
 * 输入 TypeScript 代码直接执行，支持多行（以空行结束）。
 */
async function cmdSandbox(): Promise<void> {
    log.info("启动 Sandbox REPL...");

    const sandbox = new Sandbox();
    await sandbox.start();
    log.info("Sandbox 就绪。输入 TypeScript 代码执行，输入 .exit 退出。");
    log.info("提示：多行输入以空行结束执行。");

    sandbox.on("notify", (event: Record<string, unknown>) => {
        console.log(`\n📬 [notify] ${JSON.stringify(event, null, 2)}`);
    });

    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "sandbox> ",
    });

    let buffer: string[] = [];

    rl.prompt();

    rl.on("line", async (line: string) => {
        if (line.trim() === ".exit") {
            await sandbox.stop();
            rl.close();
            process.exit(0);
        }

        if (line.trim() === ".help") {
            console.log(`
可用命令：
  .exit       退出 REPL
  .help       显示帮助
  .clear      清空输入缓冲区

直接输入 TypeScript 代码，按 Enter 执行单行。
多行代码：输入后按 Enter（空行）执行。

可用对象：ctx, runtime, memory, scene
      `);
            rl.prompt();
            return;
        }

        if (line.trim() === ".clear") {
            buffer = [];
            console.log("缓冲区已清空");
            rl.prompt();
            return;
        }

        // 多行模式
        if (line.trim() === "" && buffer.length > 0) {
            const code = buffer.join("\n");
            buffer = [];
            await executeAndPrint(sandbox, code);
            rl.prompt();
            return;
        }

        if (line.trim() === "") {
            rl.prompt();
            return;
        }

        // 单行判断：如果看起来是完整语句就直接执行
        if (buffer.length === 0 && isCompleteLine(line)) {
            await executeAndPrint(sandbox, line);
            rl.prompt();
            return;
        }

        buffer.push(line);
        rl.setPrompt("... ");
        rl.prompt();
    });

    rl.on("close", async () => {
        await sandbox.stop();
        process.exit(0);
    });
}

function isCompleteLine(line: string): boolean {
    const trimmed = line.trim();
    return (
        trimmed.endsWith(";") ||
        trimmed.endsWith(")") ||
        trimmed.startsWith("const ") ||
        trimmed.startsWith("let ") ||
        trimmed.startsWith("var ") ||
        trimmed.startsWith("await ") ||
        trimmed.startsWith("console.") ||
        trimmed.startsWith("//")
    );
}

async function executeAndPrint(sandbox: Sandbox, code: string): Promise<void> {
    const start = Date.now();
    try {
        const result = await sandbox.execute(code);
        const elapsed = Date.now() - start;

        if (result.output) {
            console.log(result.output);
        }
        if (result.error) {
            console.error(`\x1b[31m✘ Error (${elapsed}ms)\x1b[0m`);
        } else if (result.output) {
            console.log(`\x1b[90m(${elapsed}ms)\x1b[0m`);
        } else {
            console.log(`\x1b[32m✔\x1b[0m \x1b[90m(${elapsed}ms)\x1b[0m`);
        }
    } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`\x1b[31m✘ ${errorMsg}\x1b[0m`);
    }
}

/**
 * notify — 手动推送一条通知
 *
 * 用法：
 *   notify [type] [text]
 */
async function cmdNotify(args: string[]): Promise<void> {
    const eventsPath = join(DATA_DIR, "events.jsonl");
    const nc = new NotificationCenter(eventsPath, false);

    const type = args[0] ?? "test.manual";
    const text = args.slice(1).join(" ") || "手动测试通知";

    const event = nc.push({
        type,
        text,
        source: "cli",
    });

    log.info("事件已推送", {
        id: event._id,
        type: event.type,
        pendingCount: nc.pendingCount,
    });
    nc.dispose();
}


/**
 * memory — 交互式 Memory 查询
 */
async function cmdMemory(args: string[]): Promise<void> {
    const subCmd = args[0] ?? "help";

    const dbPath = join(DATA_DIR, "memory.db");
    if (!existsSync(dbPath)) {
        log.error("数据库不存在", { path: dbPath });
        log.info('提示：先运行 "npx tsx src/main.ts" 初始化数据库');
        process.exit(1);
    }

    const cfg = loadConfig();
    const embeddingConfig = resolveEmbeddingConfig(cfg);
    const memory = createMemoryStore(dbPath, { config: cfg, embeddingConfig });

    switch (subCmd) {
        case "recall": {
            const query = args.slice(1).join(" ");
            if (!query) {
                log.error('用法: memory recall <关键词>');
                break;
            }
            const result = await memory.recall(query);
            if (result.topics.length === 0 && result.facts.length === 0) {
                log.info("无搜索结果");
            } else {
                if (result.topics.length > 0) {
                    console.log(`\n\x1b[1m话题 (${result.topics.length}):\x1b[0m`);
                    for (const t of result.topics) {
                        console.log(`  \x1b[36m[${t.id.slice(0, 8)}]\x1b[0m ${t.label} — ${t.summary.slice(0, 80)}`);
                        console.log(`    ${t.startedAt} | 参与者: ${t.participants.join(", ")}`);
                    }
                }
                if (result.facts.length > 0) {
                    console.log(`\n\x1b[1m事实 (${result.facts.length}):\x1b[0m`);
                    for (const f of result.facts) {
                        console.log(`  [${f.category}] ${f.content} (关于: ${f.subject})`);
                    }
                }
            }
            break;
        }

        case "browse": {
            const intent = args.slice(1).join(" ");
            if (!intent) {
                log.error('用法: memory browse <意图描述>');
                break;
            }
            const result = await memory.browseHistory({ intent });
            if (result.segments.length === 0) {
                log.info("无匹配的消息段落");
            } else {
                if (result.answer) {
                    console.log(`\n\x1b[1m回答:\x1b[0m ${result.answer}`);
                }
                for (const seg of result.segments) {
                    console.log(`\n\x1b[36m[${seg.topicLabel}]\x1b[0m ${seg.timeRange.from} ~ ${seg.timeRange.to}`);
                    for (const m of seg.messages) {
                        console.log(`  ${m.displayName}: ${m.text.slice(0, 100)}`);
                    }
                }
                console.log(`\n总共阅读 ${result.messagesRead} 条消息`);
            }
            break;
        }

        case "status": {
            // V2 表统计
            try {
                const db = (memory as any).db;
                const topicCount = (db.prepare("SELECT COUNT(*) as cnt FROM topics").get() as any)?.cnt ?? 0;
                const factCount = (db.prepare("SELECT COUNT(*) as cnt FROM core_facts").get() as any)?.cnt ?? 0;
                const msgCount = (db.prepare("SELECT COUNT(*) as cnt FROM message_log").get() as any)?.cnt ?? 0;
                const personCount = (db.prepare("SELECT COUNT(*) as cnt FROM person_identities").get() as any)?.cnt ?? 0;
                const profileCount = (db.prepare("SELECT COUNT(*) as cnt FROM person_group_profiles").get() as any)?.cnt ?? 0;

                console.log(`\n\x1b[1m=== Memory V2 统计 ===\x1b[0m\n`);
                console.log(`  话题:     ${topicCount} 个`);
                console.log(`  事实:     ${factCount} 条`);
                console.log(`  消息日志: ${msgCount} 条`);
                console.log(`  用户身份: ${personCount} 个`);
                console.log(`  群内画像: ${profileCount} 个`);
            } catch {
                log.warn("无法读取 memory 统计");
            }
            break;
        }

        case "reflect": {
            const chatId = args[1] === "--chat" ? args[2] : args[1];
            if (!chatId) {
                log.error('用法: memory reflect --chat <chatId>');
                break;
            }
            const reflectionLlmConfigs = resolveComponentProfiles("reflection", cfg);
            log.info(`开始对群组 ${chatId} 执行 Reflection...`);
            try {
                const result = await memory.reflect(chatId, reflectionLlmConfigs, cfg.reflection);
                console.log(`\n\x1b[1m=== Reflection 结果 ===\x1b[0m\n`);
                console.log(`  时段: ${result.reflectedPeriod.from} → ${result.reflectedPeriod.to}`);
                console.log(`  画像更新: ${result.personUpdates.length} 人`);
                for (const pu of result.personUpdates) {
                    console.log(`    - ${pu.userId}: ${pu.changes}`);
                }
                console.log(`  新事实: ${result.newCoreFacts.length} 条`);
                for (const f of result.newCoreFacts) {
                    console.log(`    - ${f}`);
                }
                console.log(`  合并 episodes: ${result.mergedEpisodes}`);
                console.log(`  反思建议: ${result.insights}`);
                if (result.topicsSummary.length > 0) {
                    console.log(`  话题摘要:`);
                    for (const ts of result.topicsSummary) {
                        console.log(`    - ${ts.label}: ${ts.summary} (情感:${ts.sentiment})`);
                    }
                }
            } catch (err) {
                log.error("Reflection 失败", { error: String(err) });
            }
            break;
        }

        case "backfill-embeddings": {
            log.info(`开始为存量 fact/topic 补 embedding（model=${embeddingConfig.model}, dim=${embeddingConfig.dimensions}）...`);
            if (!cfg.embedding?.enabled) {
                log.warn("注意：embedding.enabled=false —— 补好的向量主 bot 暂不会用；需把开关打开并重启 bot 后才生效。");
            }
            try {
                const r = await memory.backfillEmbeddings();
                console.log(`\n\x1b[1m=== Backfill 完成 ===\x1b[0m`);
                console.log(`  facts:  ${r.facts} 条已补向量`);
                console.log(`  topics: ${r.topics} 条已补向量`);
            } catch (err) {
                log.error("Backfill embeddings 失败", { error: String(err) });
            }
            break;
        }

        default:
            console.log(`
\x1b[1mMemory V2 子命令：\x1b[0m

  recall <关键词>        搜索记忆（话题 + 事实）
  browse <意图描述>      浏览历史消息
  reflect --chat <id>  手动触发 Reflection
  status                查看 Memory V2 统计
  backfill-embeddings   为存量 fact/topic 补 embedding（开启 embedding 后跑一次）
      `);
    }

    memory.close();
}

/**
 * config — 检查配置加载结果
 */
async function cmdConfig(): Promise<void> {
    log.info("加载配置...");

    const config = loadConfig(undefined, true);

    console.log("\n\x1b[1mLLM Profiles：\x1b[0m");
    for (const [name, profile] of Object.entries(config.llmProfiles)) {
        console.log(`\n  \x1b[36m[${name}]\x1b[0m`);
        console.log(`    Provider:       ${profile.provider}`);
        console.log(`    Base URL:       ${profile.baseUrl}`);
        console.log(`    Model:          ${profile.model}`);
        console.log(`    Temperature:    ${profile.temperature}`);
        console.log(`    Max Tokens:     ${profile.maxTokens}`);
        console.log(`    Thinking Level: ${profile.thinkingLevel ?? "(未设置)"}`);
        console.log(`    API Key:        ${profile.apiKey ? "***" + profile.apiKey.slice(-4) : "(未设置)"}`);
    }

    console.log("\n\x1b[1m组件 LLM 路由：\x1b[0m");
    for (const [component, routeValue] of Object.entries(config.llmRouting)) {
        if (routeValue == null) {
            console.log(`  ${component.padEnd(12)} → (未配置，使用默认 profile)`);
            continue;
        }
        const names = Array.isArray(routeValue) ? routeValue : [routeValue];
        const display = names.map(n => {
            const p = config.llmProfiles[n];
            return `${n} (${p?.model ?? '⚠ profile 不存在'})`;
        }).join(" → ");
        console.log(`  ${component.padEnd(12)} → ${display}`);
    }

    console.log("\n\x1b[1mPersona：\x1b[0m");
    console.log(`  Name:        ${config.persona.name}`);
    console.log(`  Description: ${config.persona.description ? config.persona.description.slice(0, 60) + "..." : "(未设置)"}`);

    if (config.telegram) {
        console.log("\n\x1b[1mTelegram 配置：\x1b[0m");
        console.log(`  Mode:        ${config.telegram.mode}`);
        console.log(`  API ID:      ${config.telegram.apiId || "(未设置)"}`);
        console.log(`  API Hash:    ${config.telegram.apiHash ? "***" + config.telegram.apiHash.slice(-4) : "(未设置)"}`);
        console.log(`  Bot Token:   ${config.telegram.botToken ? "***" + config.telegram.botToken.slice(-4) : "(未设置)"}`);
        console.log(`  Phone:       ${config.telegram.phone || "(未设置)"}`);
    } else {
        console.log("\n\x1b[1mTelegram 配置：\x1b[0m (未配置)");
    }

    if (config.discord) {
        console.log("\n\x1b[1mDiscord 配置：\x1b[0m");
        console.log(`  Bot Token:      ${config.discord.botToken ? "***" + config.discord.botToken.slice(-4) : "(未设置)"}`);
        console.log(`  Application ID: ${config.discord.applicationId || "(未设置)"}`);
    } else {
        console.log("\n\x1b[1mDiscord 配置：\x1b[0m (未配置)");
    }
    // 检查文件
    console.log("\n\x1b[1m文件检查：\x1b[0m");
    const files = [
        "config.yaml",
        "system-prompt.md",
        join(DATA_DIR, "memory.db"),
        join(DATA_DIR, "events.jsonl"),
        join(DATA_DIR, "agent-state.md"),
    ];
    for (const f of files) {
        const exists = existsSync(f);
        const icon = exists ? "\x1b[32m✔\x1b[0m" : "\x1b[90m✘\x1b[0m";
        console.log(`  ${icon} ${f}`);
    }
}

/**
 * status — 查看 agent 状态
 */
async function cmdStatus(): Promise<void> {
    // Agent state
    const statePath = join(DATA_DIR, "agent-state.md");
    if (existsSync(statePath)) {
        console.log("\x1b[1m=== Agent State ===\x1b[0m\n");
        console.log(readFileSync(statePath, "utf-8"));
    } else {
        log.info("agent-state.md 不存在（agent 尚未运行过）");
    }

    // Recent events
    const eventsPath = join(DATA_DIR, "events.jsonl");
    if (existsSync(eventsPath)) {
        const content = readFileSync(eventsPath, "utf-8").trim();
        const lines = content ? content.split("\n") : [];
        const recent = lines.slice(-5);
        console.log(`\n\x1b[1m=== 最近事件 (${lines.length} 总, 显示最后 ${recent.length} 条) ===\x1b[0m\n`);
        for (const line of recent) {
            try {
                const event = JSON.parse(line);
                console.log(`  ${event._ts ?? ""} ${event.type ?? "unknown"}`);
            } catch {
                console.log(`  (无法解析) ${line.slice(0, 80)}`);
            }
        }
    } else {
        log.info("events.jsonl 不存在");
    }

    // Memory stats —— 仅读取本地 SQLite（不经检索后端），保证离线/任意 backend 配置下都可用
    const dbPath = join(DATA_DIR, "memory.db");
    if (existsSync(dbPath)) {
        const memory = new MemoryStoreV2(dbPath);
        try {
            const db = (memory as any).db;
            const topicCount = (db.prepare("SELECT COUNT(*) as cnt FROM topics").get() as any)?.cnt ?? 0;
            const factCount = (db.prepare("SELECT COUNT(*) as cnt FROM core_facts").get() as any)?.cnt ?? 0;
            const msgCount = (db.prepare("SELECT COUNT(*) as cnt FROM message_log").get() as any)?.cnt ?? 0;
            const personCount = (db.prepare("SELECT COUNT(*) as cnt FROM person_identities").get() as any)?.cnt ?? 0;

            console.log(`\n\x1b[1m=== Memory V2 统计 ===\x1b[0m\n`);
            console.log(`  话题:     ${topicCount} 个`);
            console.log(`  事实:     ${factCount} 条`);
            console.log(`  消息日志: ${msgCount} 条`);
            console.log(`  用户身份: ${personCount} 个`);
        } catch {
            log.warn("无法读取 memory 统计");
        }
        memory.close();
    }
}

// ─── Main ───

const HELP = `
\x1b[1mCyberGroupmate CLI — 调试工具\x1b[0m

用法: npx tsx src/cli.ts <command> [args...]

命令:
  sandbox                交互式 Sandbox REPL
  notify [type] [text]   推送一条通知到队列
  memory <subcmd>        记忆系统查询（recall/browse/reflect/status）
  config                 检查配置加载结果
  status                 查看 agent 运行状态和统计

环境变量:
  LOG_LEVEL=debug|info|warn|error   日志级别（默认: info）
  LOG_FORMAT=text|json              日志格式（默认: text）
`;

async function main(): Promise<void> {
    const [_node, _script, command, ...args] = process.argv;

    switch (command) {
        case "sandbox":
            await cmdSandbox();
            break;
        case "notify":
            await cmdNotify(args);
            break;
        case "memory":
        case "mem":
            await cmdMemory(args);
            break;
        case "config":
            await cmdConfig();
            break;
        case "status":
            await cmdStatus();
            break;
        default:
            console.log(HELP);
            break;
    }
}

main().catch((err) => {
    log.error("CLI 异常", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
});
