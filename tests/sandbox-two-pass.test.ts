import { describe, it } from "node:test";
import assert from "node:assert/strict";

// 从核心文件中导入需要验证的模块
import { loadApiTypeDefs } from "../src/subagent/code-act-executor.js";
import { loadModuleRegistry, lookupFullDocs } from "../src/sandbox/modules/module-registry.js";
import { buildPrefixMap, extractApiCalls, getDocLookupMethods, needsDocLookup } from "../src/sandbox/api-intent-extractor.js";
import type { ChatMessage } from "../src/core/llm/types.js";

describe("TS Skills Two-Pass Architecture (Context & Deduplication)", () => {
    const registry = loadModuleRegistry();
    const prefixMap = buildPrefixMap(registry);

    it("Phase 1: loadApiTypeDefs should only expose brief overviews, not full docs", () => {
        const briefDocsTelegram = loadApiTypeDefs("telegram");

        // 验证 1: 包含内建的简短概览 (例如 runtime, telegram)
        assert.ok(briefDocsTelegram.includes("## runtime"), "Should contain runtime brief");
        assert.ok(briefDocsTelegram.includes("## telegram"), "Should contain telegram brief");
        
        // 验证 2: 绝不包含详细的 JSDoc 参数说明 (如 @param, @example)
        assert.equal(briefDocsTelegram.includes("@example"), false, "Should not contain heavy JSDoc @example in Phase 1");
        assert.equal(briefDocsTelegram.includes("@param"), false, "Should not contain heavy JSDoc @param in Phase 1");

        // 验证 3: 环境过滤，telegram 环境不应该看到 discord 模块
        assert.equal(briefDocsTelegram.includes("## discord"), false, "Should filter out discord from telegram system prompt");
    });

    it("Phase 2: Intent extraction and Full Doc Injection", () => {
        const pass1Code = `
            await telegram.sendText(123, "hello");
            await telegram.sendSticker(123, "AgAD5xcAAk7BUVQ");
        `;

        const calledMethods = extractApiCalls(pass1Code, prefixMap);
        assert.ok(calledMethods.includes("telegram.sendText"));
        assert.ok(calledMethods.includes("telegram.sendSticker"));

        assert.equal(needsDocLookup(calledMethods), true);

        // 模拟提取 full doc
        const docLookupMethods = getDocLookupMethods(calledMethods);
        const fullDocs = lookupFullDocs(registry, docLookupMethods);
        
        // 验证 1: fullDocs 应该包含需要查文档的方法标记，但不包含 trivial 方法
        assert.equal(fullDocs.includes("### telegram.sendText"), false);
        assert.ok(fullDocs.includes("### telegram.sendSticker"));

        // 验证 2: fullDocs 应该包含原本从 brief 中被抠掉的完整签名与用法说明
        assert.ok(fullDocs.includes("sendSticker(chatId: number | string"));
        assert.ok(fullDocs.includes("通过 uniqueFileId 引用本地已缓存的贴纸文件"));
    });

    it("Phase 3: Stateless Deduplication across Multi-Round context", () => {
        // 模拟当前的上下文 Messages
        const messages: ChatMessage[] = [
            { role: "system", content: "You are an agent..." },
            { role: "user", content: "hi, please send a message and sticker." },
            { role: "assistant", content: "Let me do that." }
        ];

        // 模拟第一轮 (Turn 0) 生成的代码
        const pass1Code = `
            await telegram.sendText(123, "hello");
            await telegram.sendSticker(123, "AgAD5xcAAk7BUVQ");
        `;
        const calledMethodsRound1 = extractApiCalls(pass1Code, prefixMap);
        assert.deepEqual(calledMethodsRound1.sort(), ["telegram.sendText", "telegram.sendSticker"].sort());
        const docLookupMethodsRound1 = getDocLookupMethods(calledMethodsRound1);
        assert.deepEqual(docLookupMethodsRound1, ["telegram.sendSticker"]);

        // 执行无状态去重过滤 (首次：全部 Missing)
        const missingMethodsRound1 = docLookupMethodsRound1.filter(method => {
            const marker = `### ${method}`;
            return !messages.some(m => typeof m.content === "string" && m.content.includes(marker));
        });
        
        assert.equal(missingMethodsRound1.length, 1, "First round only injects non-trivial docs");
        assert.equal(missingMethodsRound1[0], "telegram.sendSticker");

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
            // Agent 又调用了一次已加载过文档的方法
            await telegram.sendSticker(123, "AgAD5xcAAk7BUVQ");
            // 同时调用了一个 trivial 方法
            await telegram.sendText(456, "Another message");
        `;

        const calledMethodsRound2 = extractApiCalls(subsequentCode, prefixMap);
        assert.ok(calledMethodsRound2.includes("telegram.sendText"));
        assert.ok(calledMethodsRound2.includes("telegram.sendSticker"));
        const docLookupMethodsRound2 = getDocLookupMethods(calledMethodsRound2);
        assert.deepEqual(docLookupMethodsRound2, ["telegram.sendSticker"]);

        // 第二轮执行无状态去重过滤
        const missingMethodsRound2 = docLookupMethodsRound2.filter(method => {
            const marker = `### ${method}`;
            return !messages.some(m => typeof m.content === "string" && m.content.includes(marker));
        });

        // 已存在于上下文的非 trivial 方法被剔除，trivial 方法根本不参与 missing doc 检查
        assert.deepEqual(missingMethodsRound2, []);
        assert.equal(needsDocLookup(missingMethodsRound2), false);
    });

    it("Phase 3b: Trivial calls should not be injected when a documented non-trivial call triggers Two-pass", () => {
        const messages: ChatMessage[] = [
            { role: "system", content: "You are an agent..." },
            {
                role: "user",
                content: `[📚 API 文档加载完成]\n\n${lookupFullDocs(registry, ["telegram.sendSticker"])}`
            },
        ];

        const code = `
            await telegram.sendText(123, "才不要");
            await telegram.sendSticker(123, "AgAD5xcAAk7BUVQ");
        `;

        const calledMethods = extractApiCalls(code, prefixMap);
        assert.ok(calledMethods.includes("telegram.sendText"));
        assert.ok(calledMethods.includes("telegram.sendSticker"));

        const docLookupMethods = getDocLookupMethods(calledMethods);
        assert.deepEqual(docLookupMethods, ["telegram.sendSticker"]);

        const missingMethods = docLookupMethods.filter(method => {
            const marker = `### ${method}`;
            return !messages.some(m => typeof m.content === "string" && m.content.includes(marker));
        });

        assert.deepEqual(missingMethods, []);
    });

    it("Phase 4: Re-Injection after context compaction", () => {
        // 模拟 session compaction: 旧的历史被清空，只保留系统提示
        const messages: ChatMessage[] = [
            { role: "system", content: "You are an agent... [some summary]" },
        ]; // <-- 之前被注入的 Markdown Docs 已经被删了

        const subsequentCode = `
            // Agent 在被 compact 后再次凭借记忆使用了
            await telegram.sendSticker(999, "AgAD5xcAAk7BUVQ");
        `;

        const calledMethods = extractApiCalls(subsequentCode, prefixMap);
        const docLookupMethods = getDocLookupMethods(calledMethods);
        
        // 第三轮全量检测
        const missingMethodsRound3 = docLookupMethods.filter(method => {
            const marker = `### ${method}`;
            return !messages.some(m => typeof m.content === "string" && m.content.includes(marker));
        });

        // 验证: 尽管之前注入过，但无状态设计发现窗口里没了，就会老老实实地重新判定需要注入
        assert.equal(missingMethodsRound3.length, 1);
        assert.equal(missingMethodsRound3[0], "telegram.sendSticker");
    });
});
