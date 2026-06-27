/**
 * tests/privacy-config.test.ts — privacy 配置解析（parseBool 健壮性 + 默认值）
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearConfigCache, loadConfig } from "../src/core/config.js";

const tempDirs: string[] = [];

function writeConfig(lines: string[]): string {
    const dir = join(tmpdir(), `privacy-cfg-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    tempDirs.push(dir);
    const p = join(dir, "config.yaml");
    writeFileSync(p, lines.join("\n"));
    return p;
}

after(() => {
    clearConfigCache();
    for (const d of tempDirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
});

describe("privacy config 解析", () => {
    it("parseBool: off / \"false\" 等写法都关闭（不被 Boolean 误判为 true）", () => {
        clearConfigCache();
        const cfg = loadConfig(writeConfig([
            "privacy:",
            "  allow_llm_mark_sensitive: off",
            "  dm_auto_private: \"false\"",
            "  enforce: warn",
        ]));
        assert.equal(cfg.privacy.allowLlmMarkSensitive, false);
        assert.equal(cfg.privacy.dmAutoPrivate, false);
        assert.equal(cfg.privacy.enforce, "warn");
    });

    it("parseBool: 无法识别的值回退默认（不 fail-open 成 true）", () => {
        clearConfigCache();
        const cfg = loadConfig(writeConfig([
            "privacy:",
            "  allow_llm_mark_sensitive: maybe",
        ]));
        assert.equal(cfg.privacy.allowLlmMarkSensitive, true); // 默认 true
        assert.equal(cfg.privacy.dmAutoPrivate, true); // 缺省默认
    });

    it("默认（无 privacy 段、无 legacy）= block + dmAutoPrivate + allow + 空名单", () => {
        clearConfigCache();
        const cfg = loadConfig(writeConfig(["persona:", "  name: x"]));
        assert.equal(cfg.privacy.enforce, "block");
        assert.equal(cfg.privacy.dmAutoPrivate, true);
        assert.equal(cfg.privacy.allowLlmMarkSensitive, true);
        assert.deepEqual(cfg.privacy.sensitiveChats, []);
    });
});
