/**
 * reply-prompt.test.ts — per-profile reply_prompt 解析 / 路由查找 / 序列化往返
 *
 * 覆盖 commit de801d0 的数据契约：
 *   - config 解析 `reply_prompt` → LLMConfig.replyPrompt
 *   - executor 用 resolveComponentProfiles("session")[0]?.replyPrompt 读取该值（这里复刻同一查找）
 *   - 空串不落成假值；未配置则 undefined（executor 的 `if (replyBoost)` 据此跳过注入）
 *   - serializeConfigToObject 往返：有值回写 reply_prompt、无值不写键
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    clearConfigCache,
    loadConfig,
    resolveComponentProfiles,
    serializeConfigToObject,
} from "../src/core/config.js";

const tempDirs: string[] = [];

function writeConfig(lines: string[]): string {
    const dir = join(tmpdir(), `reply-prompt-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    tempDirs.push(dir);
    const p = join(dir, "config.yaml");
    writeFileSync(p, lines.join("\n"));
    return p;
}

const REPLY_TEXT = "保持简短口语，别用书面腔。";

/** 一份带 replier(有 reply_prompt) + plain(无) 的最小配置，session 路由到 replier。 */
function baseConfigLines(replyPromptLine?: string): string[] {
    return [
        "llm_profiles:",
        "  replier:",
        "    provider: openai",
        "    base_url: https://example.test/v1",
        "    api_key: x",
        "    model: test-model",
        ...(replyPromptLine ? [`    ${replyPromptLine}`] : []),
        "  plain:",
        "    provider: openai",
        "    base_url: https://example.test/v1",
        "    api_key: x",
        "    model: test-model",
        "llm_routing:",
        "  session: replier",
    ];
}

after(() => {
    clearConfigCache();
    for (const d of tempDirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
});

describe("reply_prompt 配置", () => {
    it("session profile 解析出 replyPrompt（executor 据此在 task prompt 末尾注入）", () => {
        clearConfigCache();
        const cfg = loadConfig(writeConfig(baseConfigLines(`reply_prompt: "${REPLY_TEXT}"`)));
        // executor 实际用的查找：resolveComponentProfiles("session")[0]?.replyPrompt
        const sessionProfile = resolveComponentProfiles("session", cfg)[0];
        assert.equal(sessionProfile.replyPrompt, REPLY_TEXT);
    });

    it("未配置 reply_prompt 的 profile → replyPrompt 为 undefined（注入被跳过）", () => {
        clearConfigCache();
        const cfg = loadConfig(writeConfig(baseConfigLines()));
        assert.equal(resolveComponentProfiles("session", cfg)[0].replyPrompt, undefined);
        assert.equal(cfg.llmProfiles.plain.replyPrompt, undefined);
    });

    it("空串 reply_prompt 归一为 undefined（不会注入一段空提示）", () => {
        clearConfigCache();
        const cfg = loadConfig(writeConfig(baseConfigLines(`reply_prompt: ""`)));
        assert.equal(cfg.llmProfiles.replier.replyPrompt, undefined);
    });

    it("序列化往返：有值回写 reply_prompt、无值不写该键", () => {
        clearConfigCache();
        const cfg = loadConfig(writeConfig(baseConfigLines(`reply_prompt: "${REPLY_TEXT}"`)));
        const obj = serializeConfigToObject(cfg) as { llm_profiles: Record<string, any> };
        assert.equal(obj.llm_profiles.replier.reply_prompt, REPLY_TEXT);
        assert.ok(
            !("reply_prompt" in obj.llm_profiles.plain),
            "无 reply_prompt 的 profile 不应序列化出该键",
        );
    });
});
