import { describe, it } from "node:test";
import assert from "node:assert/strict";

// 从核心文件中导入需要验证的模块
import { loadApiTypeDefs } from "../src/subagent/code-act-executor.js";
import { loadModuleRegistry, lookupFullDocs } from "../src/sandbox/modules/module-registry.js";
import { buildPrefixMap, extractApiCalls, needsDocLookup } from "../src/sandbox/api-intent-extractor.js";
import type { ChatMessage } from "../src/core/llm/types.js";

describe("TS Skills Two-Pass Architecture (Context & Deduplication)", () => {
    const registry = loadModuleRegistry();
    const prefixMap = buildPrefixMap(registry, ["github"]);

    it("Phase 1: loadApiTypeDefs should only expose brief overviews, not full docs", () => {
        const briefDocsTelegram = loadApiTypeDefs("telegram");

        // 验证 1: 包含内建的简短概览 (例如 runtime, telegram)
        assert.ok(briefDocsTelegram.includes("## runtime"), "Should contain runtime brief");
        assert.ok(briefDocsTelegram.includes("## telegram"), "Should contain telegram brief");
        
        // 验证 2: 包含用户自定义的 Skill (github)
        assert.ok(briefDocsTelegram.includes("## github"), "Should contain user skill github brief");
        assert.ok(briefDocsTelegram.includes("- createIssue"), "Should contain createIssue brief");

        // 验证 3: 绝不包含详细的 JSDoc 参数说明 (如 @param, @example)
        assert.equal(briefDocsTelegram.includes("@example"), false, "Should not contain heavy JSDoc @example in Phase 1");
        assert.equal(briefDocsTelegram.includes("@param"), false, "Should not contain heavy JSDoc @param in Phase 1");

        // 验证 4: 环境过滤，telegram 环境不应该看到 discord 模块
        assert.equal(briefDocsTelegram.includes("## discord"), false, "Should filter out discord from telegram system prompt");
    });

    it("Phase 2: Intent extraction and Full Doc Injection", () => {
        const pass1Code = `
            await telegram.sendText(123, "hello");
            const repo = await github.getRepo("owner", "repo");
            console.log(repo.title);
        `;

        const calledMethods = extractApiCalls(pass1Code, prefixMap);
        assert.ok(calledMethods.includes("telegram.sendText"));
        assert.ok(calledMethods.includes("github.getRepo"));

        assert.equal(needsDocLookup(calledMethods), true);

        // 模拟提取 full doc
        const fullDocs = lookupFullDocs(registry, calledMethods);
        
        // 验证 1: fullDocs 应该包含 "### module.method" 标记
        assert.ok(fullDocs.includes("### telegram.sendText"));
        assert.ok(fullDocs.includes("### github.getRepo"));

        // 验证 2: fullDocs 应该包含原本从 brief 中被抠掉的详细 JSDoc（例如被 parse 后的“参数：”特征）
        assert.ok(fullDocs.includes("参数："));
    });

    it("Phase 3: Stateless Deduplication across Multi-Round context", () => {
        // 模拟当前的上下文 Messages
        const messages: ChatMessage[] = [
            { role: "system", content: "You are an agent..." },
            { role: "user", content: "hi, please send a message and list my GitHub issues." },
            { role: "assistant", content: "Let me do that." }
        ];

        // 模拟第一轮 (Turn 0) 生成的代码
        const pass1Code = `
            await telegram.sendText(123, "hello");
            const issues = await github.listIssues("owner", "repo");
        `;
        const calledMethodsRound1 = extractApiCalls(pass1Code, prefixMap);
        assert.deepEqual(calledMethodsRound1.sort(), ["telegram.sendText", "github.listIssues"].sort());

        // 执行无状态去重过滤 (首次：全部 Missing)
        const missingMethodsRound1 = calledMethodsRound1.filter(method => {
            const marker = `### ${method}`;
            return !messages.some(m => typeof m.content === "string" && m.content.includes(marker));
        });
        
        assert.equal(missingMethodsRound1.length, 2, "First round requires injecting both docs");

        // 模拟 Pass 2 补充了这些文档进入 messages
        const fullDocsRound1 = lookupFullDocs(registry, missingMethodsRound1);
        messages.push({
            role: "user",
            content: `[📚 API 文档加载完成]\n\n${fullDocsRound1}`
        });

        // ==========================================
        // 模拟后续执行轮次 (大模型在后面的步骤又使用了同一个方法)
        // ==========================================
        const subsequentCode = `
            // Agent 又调用了一次 sendText
            await telegram.sendText(456, "Another message");
            // 同时调用了一个新模块方法
            const ps = await runtime.ps();
        `;

        const calledMethodsRound2 = extractApiCalls(subsequentCode, prefixMap);
        assert.ok(calledMethodsRound2.includes("telegram.sendText"));
        assert.ok(calledMethodsRound2.includes("runtime.ps"));

        // 第二轮执行无状态去重过滤
        const missingMethodsRound2 = calledMethodsRound2.filter(method => {
            const marker = `### ${method}`;
            return !messages.some(m => typeof m.content === "string" && m.content.includes(marker));
        });

        // 验证 1: 已存在于上下文的 "telegram.sendText" 被剔除，不再触发重复注入
        assert.equal(missingMethodsRound2.includes("telegram.sendText"), false);
        
        // 验证 2: 只有新出现的 "runtime.ps" 且非 Trivial 的才继续后续动作
        // 注意：runtime.ps 在 TRIVIAL_CALLS 中，所以最终需要经过 needsDocLookup 判断
        assert.equal(missingMethodsRound2.includes("runtime.ps"), true);
        
        // needsDocLookup("runtime.ps") 是 false，所以不会触发 Two-pass
        const requiresPass2 = needsDocLookup(missingMethodsRound2);
        assert.equal(requiresPass2, false, "runtime.ps is trivial, should skip two-pass completely");
    });

    it("Phase 4: Re-Injection after context compaction", () => {
        // 模拟 session compaction: 旧的历史被清空，只保留系统提示
        const messages: ChatMessage[] = [
            { role: "system", content: "You are an agent... [some summary]" },
        ]; // <-- 之前被注入的 Markdown Docs 已经被删了

        const subsequentCode = `
            // Agent 在被 compact 后再次凭借记忆使用了
            await telegram.sendText(999, "Compact later");
        `;

        const calledMethods = extractApiCalls(subsequentCode, prefixMap);
        
        // 第三轮全量检测
        const missingMethodsRound3 = calledMethods.filter(method => {
            const marker = `### ${method}`;
            return !messages.some(m => typeof m.content === "string" && m.content.includes(marker));
        });

        // 验证: 尽管之前注入过，但无状态设计发现窗口里没了，就会老老实实地重新判定需要注入
        assert.equal(missingMethodsRound3.length, 1);
        assert.equal(missingMethodsRound3[0], "telegram.sendText");
    });
});
