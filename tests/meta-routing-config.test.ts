import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearConfigCache, loadConfig, resolveComponentProfiles, serializeConfigToYAML } from "../src/core/config.js";

const tempDirs: string[] = [];

function tempDir(): string {
    const dir = join(tmpdir(), `meta-routing-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    tempDirs.push(dir);
    return dir;
}

after(() => {
    clearConfigCache();
    for (const dir of tempDirs) {
        if (existsSync(dir)) {
            rmSync(dir, { recursive: true, force: true });
        }
    }
});

describe("config meta routing", () => {
    it("resolves llm_routing.meta profiles", () => {
        const dir = tempDir();
        const configPath = join(dir, "config.yaml");

        writeFileSync(configPath, [
            "llm_profiles:",
            "  primary:",
            "    provider: openai",
            "    base_url: https://example.invalid/v1",
            "    api_key: key-primary",
            "    model: model-primary",
            "    temperature: 0.1",
            "    max_tokens: 1000",
            "  fallback:",
            "    provider: openai",
            "    base_url: https://example.invalid/v1",
            "    api_key: key-fallback",
            "    model: model-fallback",
            "    temperature: 0.2",
            "    max_tokens: 2000",
            "llm_routing:",
            "  meta:",
            "    - primary",
            "    - fallback",
            "persona:",
            "  name: test",
            "  description: test",
            "notification:",
            "  mention_keywords: []",
            "reflection: {}",
            "embedding:",
            "  provider: local",
            "  base_url: https://example.invalid/v1",
            "  api_key: ''",
            "  model: embed-local",
            "  dimensions: 128",
            "  similarity_metric: cosine",
        ].join("\n"));

        clearConfigCache();
        const config = loadConfig(configPath, true);
        const profiles = resolveComponentProfiles("meta", config);

        assert.equal(profiles.length, 2);
        assert.equal(profiles[0]?.model, "model-primary");
        assert.equal(profiles[1]?.model, "model-fallback");
    });

    it("parses subagent.meta_history budget config", () => {
        const dir = tempDir();
        const configPath = join(dir, "config.yaml");

        writeFileSync(configPath, [
            "llm_profiles:",
            "  default:",
            "    provider: openai",
            "    base_url: https://example.invalid/v1",
            "    api_key: key-default",
            "    model: model-default",
            "    temperature: 0.1",
            "    max_tokens: 1000",
            "llm_routing: {}",
            "persona:",
            "  name: test",
            "  description: test",
            "notification:",
            "  mention_keywords: []",
            "reflection: {}",
            "embedding:",
            "  provider: local",
            "  base_url: https://example.invalid/v1",
            "  api_key: ''",
            "  model: embed-local",
            "  dimensions: 128",
            "  similarity_metric: cosine",
            "subagent:",
            "  deduplicate_sent_messages: false",
            "  meta_history:",
            "    soft_char_limit: 22000",
            "    trim_target_chars: 12000",
            "    min_messages: 10",
            "    hard_message_limit: 60",
            "    trim_target_messages: 40",
        ].join("\n"));

        clearConfigCache();
        const config = loadConfig(configPath, true);

        assert.equal(config.subagent?.deduplicateSentMessages, false);
        assert.equal(config.subagent?.metaHistory?.softCharLimit, 22000);
        assert.equal(config.subagent?.metaHistory?.trimTargetChars, 12000);
        assert.equal(config.subagent?.metaHistory?.minMessages, 10);
        assert.equal(config.subagent?.metaHistory?.hardMessageLimit, 60);
        assert.equal(config.subagent?.metaHistory?.trimTargetMessages, 40);
        assert.match(serializeConfigToYAML(config), /deduplicate_sent_messages: false/);
    });
});
