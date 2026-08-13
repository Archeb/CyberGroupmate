import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    clearConfigCache,
    loadConfig,
    serializeConfigToObject,
} from "../src/core/config.js";

const tempDirs: string[] = [];

after(() => {
    clearConfigCache();
    for (const dir of tempDirs) {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
});

describe("Responses WebSocket config", () => {
    it("parses and serializes websocket request options", () => {
        const dir = join(tmpdir(), `responses-websocket-config-${randomUUID()}`);
        mkdirSync(dir, { recursive: true });
        tempDirs.push(dir);
        const configPath = join(dir, "config.yaml");
        writeFileSync(configPath, [
            "llm_profiles:",
            "  responses:",
            "    provider: openai_responses",
            "    base_url: https://example.invalid/v1",
            "    api_key: test-key",
            "    model: reasoning-model",
            "    responses_request_mode: websocket",
            "    omit_max_output_tokens: true",
            "llm_routing:",
            "  session: responses",
        ].join("\n"));

        clearConfigCache();
        const config = loadConfig(configPath, true);
        const profile = config.llmProfiles.responses;
        assert.equal(profile.responsesRequestMode, "websocket");
        assert.equal(profile.omit_max_output_tokens, true);

        const serialized = serializeConfigToObject(config) as { llm_profiles: Record<string, any> };
        assert.equal(serialized.llm_profiles.responses.responses_request_mode, "websocket");
        assert.equal(serialized.llm_profiles.responses.omit_max_output_tokens, true);
    });
});
