import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityRegistryEnv } from "../src/sandbox/capability-registry.js";
import { createOneBotClientProxy } from "../src/sandbox/modules/onebot/index.js";

describe("OneBot sandbox proxy media download", () => {
    it("writes host-downloaded bytes to the sandbox workspace", async () => {
        const oldCwd = process.cwd();
        const dir = mkdtempSync(join(tmpdir(), "onebot-proxy-download-"));
        const outputs: string[] = [];
        const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

        try {
            process.chdir(dir);
            const env: CapabilityRegistryEnv = {
                ctx: {},
                emitOutput: (line) => outputs.push(line),
                notifyHost: () => {},
                requestInput: async () => "",
                printToHost: () => {},
                spawnTask: () => {},
                killTask: () => {},
                listTasks: () => [],
                callHost: async (method, args = []) => {
                    assert.equal(method, "onebot.downloadMedia");
                    assert.deepEqual(args, ["794582600"]);
                    return { buffer: bytes.toString("base64"), size: bytes.length };
                },
            };

            const client = createOneBotClientProxy(env, new Map(), false) as {
                downloadMedia(mediaRef: string | number): Promise<string>;
            };
            const localPath = await client.downloadMedia(794582600);

            assert.match(localPath, /^Downloads\/onebot_794582600_[a-f0-9]+\.png$/);
            assert.ok(existsSync(join(dir, localPath)));
            assert.deepEqual(readFileSync(join(dir, localPath)), bytes);
            assert.ok(outputs.some(line => line.includes("[QQ] downloadMedia ok")));
        } finally {
            process.chdir(oldCwd);
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
