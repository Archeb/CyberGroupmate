import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import {
    clearConfigCache,
    loadConfig,
    saveConfig,
    serializeConfigToObject,
    serializeConfigToYAML,
    validateConfig,
    type AppConfig,
    type FeishuConfig,
} from "../src/core/config.js";

const tempDir = mkdtempSync(join(tmpdir(), "feishu-config-"));
const validAppId = "cli_0123456789abcdef";
let fileIndex = 0;

function load(raw: Record<string, unknown>): AppConfig {
    const path = join(tempDir, `${fileIndex++}.yaml`);
    writeFileSync(path, stringify(raw));
    return loadConfig(path, true);
}

function baseConfig(): AppConfig {
    return load({ llm_profiles: { default: { api_key: "test-key" } } });
}

function roundtrip(config: AppConfig): AppConfig {
    const path = join(tempDir, `${fileIndex++}.yaml`);
    writeFileSync(path, serializeConfigToYAML(config));
    return loadConfig(path, true);
}

after(() => {
    clearConfigCache();
    rmSync(tempDir, { recursive: true, force: true });
});

describe("Feishu config boundaries", () => {
    it("keeps absent, null, empty and blank credentials disabled", () => {
        for (const feishu of [undefined, null, {}, { app_id: "", app_secret: "" }, { app_id: " \t", app_secret: "\n " }, { domain: "lark" }]) {
            const config = load({ feishu });
            assert.equal(config.feishu, undefined);
            assert.equal(serializeConfigToObject(config).feishu, undefined);
            assert.equal(roundtrip(config).feishu, undefined);
        }
        for (const feishu of [undefined, null, {}, { appId: "", appSecret: "" }]) {
            const config = { ...baseConfig(), feishu };
            assert.equal(validateConfig(config).valid, true);
            assert.equal(serializeConfigToObject(config as AppConfig).feishu, undefined);
        }
    });

    it("keeps the example disabled", () => {
        assert.equal(loadConfig(new URL("../config.example.yaml", import.meta.url).pathname, true).feishu, undefined);
    });

    it("roundtrips snake YAML and camel runtime for both domains and omitted domain", () => {
        for (const domain of [undefined, "feishu", "lark"] as const) {
            const feishu: FeishuConfig = {
                appId: validAppId,
                appSecret: "test-secret",
                ...(domain ? { domain } : {}),
            };
            const yaml = {
                app_id: feishu.appId,
                app_secret: feishu.appSecret,
                ...(domain ? { domain } : {}),
            };
            const parsed = load({ feishu: yaml });
            assert.deepEqual(parsed.feishu, feishu);
            assert.deepEqual(serializeConfigToObject(parsed).feishu, yaml);
            assert.deepEqual(roundtrip(parsed).feishu, feishu);
            const config = { ...baseConfig(), feishu };
            assert.equal(validateConfig(config).valid, true);
            assert.deepEqual(roundtrip(config).feishu, feishu);
        }
    });

    it("rejects either missing credential without including secret values in errors", () => {
        for (const feishu of [
            { app_id: validAppId },
            { app_secret: "test-secret" },
            { app_id: " ", app_secret: "test-secret" },
            { app_id: validAppId, app_secret: " " },
        ]) {
            assert.throws(() => load({ feishu }), (err: Error) => {
                assert.match(err.message, /feishu\.app_id.*feishu\.app_secret.*non-empty/);
                assert.equal(err.message.includes("test-secret"), false);
                return true;
            });
            const config = { ...baseConfig(), feishu: { appId: feishu.app_id, appSecret: feishu.app_secret } };
            const result = validateConfig(config);
            assert.equal(result.valid, false);
            assert.match(result.errors.join(" "), /feishu\.appId.*feishu\.appSecret.*non-empty/);
            assert.equal(result.errors.join(" ").includes("test-secret"), false);
        }
    });

    it("rejects non-string credentials and non-object blocks", () => {
        for (const value of [0, false, [], {}]) {
            for (const field of ["app_id", "app_secret"]) {
                assert.throws(() => load({ feishu: { app_id: validAppId, app_secret: "test-secret", [field]: value } }), /must be a string/);
            }
            for (const field of ["appId", "appSecret"]) {
                assert.equal(validateConfig({ ...baseConfig(), feishu: { appId: validAppId, appSecret: "test-secret", [field]: value } }).valid, false);
            }
        }
        for (const feishu of [false, 0, "", "test-secret", []]) {
            assert.throws(() => load({ feishu }), /feishu must be an object or null/);
            assert.equal(validateConfig({ ...baseConfig(), feishu }).valid, false);
        }
    });

    it("rejects invalid domains even when credentials are blank", () => {
        for (const domain of ["", "Lark", "other", null, false, 123, {}]) {
            for (const credentials of [{}, { app_id: validAppId, app_secret: "test-secret" }]) {
                assert.throws(() => load({ feishu: { ...credentials, domain } }), /feishu\.domain must be "feishu" or "lark"/);
            }
            const config = { ...baseConfig(), feishu: { appId: validAppId, appSecret: "test-secret", domain } };
            const result = validateConfig(config);
            assert.equal(result.valid, false);
            assert.deepEqual(result.errors, ['feishu.domain must be "feishu" or "lark"']);
        }
    });

    it("does not overwrite the saved file on invalid Feishu input", () => {
        const config = baseConfig();
        const path = join(tempDir, `${fileIndex++}.yaml`);
        const original = serializeConfigToYAML(config);
        writeFileSync(path, original);
        const result = saveConfig({ ...config, feishu: { appId: "", appSecret: "test-secret" } }, path);
        assert.equal(result.ok, false);
        assert.equal(result.error?.includes("test-secret"), false);
        assert.equal(readFileSync(path, "utf-8"), original);
    });

    it("rejects App IDs that runtime startup would reject", () => {
        for (const appId of ["cli_test", "cli_0123456789abcde", "cli_0123456789abcdef0", "app_0123456789abcdef", "cli_0123456789abcdeg"]) {
            assert.throws(() => load({ feishu: { app_id: appId, app_secret: "test-secret" } }), /must match cli_/);
            const result = validateConfig({ ...baseConfig(), feishu: { appId, appSecret: "test-secret" } });
            assert.equal(result.valid, false);
            assert.match(result.errors.join(" "), /feishu\.appId must match cli_/);
        }
    });

    it("allows configured Feishu ingress when migrating legacy adapter whitelists", () => {
        for (const legacy of [
            { telegram: { mode: "bot_api", bot_token: "token", whitelist: { enabled: true, groups: ["-1001"], users: [] } } },
            { onebot: { ws_url: "ws://localhost", self_id: "1", whitelist: { enabled: true, groups: ["1001"], users: [] } } },
        ]) {
            const config = load({
                feishu: { app_id: validAppId, app_secret: "test-secret" },
                ...legacy,
            });
            assert.ok(config.chatFilter?.chatIds?.includes("feishu:*"));
        }
    });
});

describe("config serialization regressions", () => {
    it("preserves every backfill field including explicit false flags", () => {
        for (const enabled of [false, true]) {
            const config = baseConfig();
            config.backfill = {
                enabled,
                maxMessagesPerChat: 1,
                maxChats: 2,
                maxAgeMinutes: 3,
                delayMs: 4,
                downloadMedia: enabled,
            };
            assert.deepEqual(serializeConfigToObject(config).backfill, {
                enabled,
                max_messages_per_chat: 1,
                max_chats: 2,
                max_age_minutes: 3,
                delay_ms: 4,
                download_media: enabled,
            });
            assert.deepEqual(roundtrip(config).backfill, config.backfill);
        }
    });

    it("preserves MCP transports, interpolation and false auto_connect", () => {
        const config = load({
            mcp_servers: [
                { name: "local", transport: "stdio", command: "test-command", args: ["${TEST_ARG}"], env: { TEST_KEY: "${TEST_KEY}" }, auto_connect: false },
                { name: "remote", transport: "streamable-http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer ${TEST_KEY}" }, auto_connect: true },
                { name: "default", command: "test-command", args: [], env: {} },
            ],
        });
        const serialized = serializeConfigToObject(config).mcp_servers as Record<string, unknown>[];
        assert.equal(serialized[0].auto_connect, false);
        assert.equal(serialized[1].auto_connect, true);
        assert.equal(Object.hasOwn(serialized[2], "auto_connect"), false);
        assert.equal(Object.hasOwn(serialized[0], "autoConnect"), false);
        assert.deepEqual(roundtrip(config).mcpServers, config.mcpServers);
    });

    it("does not introduce absent backfill or MCP settings", () => {
        const serialized = serializeConfigToObject(baseConfig());
        assert.equal(Object.hasOwn(serialized, "backfill"), false);
        assert.equal(Object.hasOwn(serialized, "mcp_servers"), false);
    });
});
