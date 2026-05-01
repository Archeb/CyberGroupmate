import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MetaSandbox } from "../src/meta-sandbox/meta-sandbox.js";

describe("MetaSandbox", () => {
    it("executes async API calls inside the sandbox", async () => {
        const sandbox = new MetaSandbox({
            agents: {
                listStatus: async () => [{ chatId: "telegram:1" }],
            },
        });

        const result = await sandbox.execute(`
const rows = await agents.listStatus();
return rows[0].chatId;
`);

        assert.equal(result.error, false);
        assert.equal(result.output, "telegram:1");
    });

    it("captures console output", async () => {
        const sandbox = new MetaSandbox({});
        const result = await sandbox.execute(`
console.log("hello", { scope: "meta" });
console.warn("watch");
`);

        assert.equal(result.error, false);
        assert.equal(result.logs.length, 2);
        assert.match(result.output, /\[log\] hello/);
        assert.match(result.output, /\[warn\] watch/);
    });

    it("returns script errors", async () => {
        const sandbox = new MetaSandbox({});
        const result = await sandbox.execute(`
throw new Error("boom");
`);

        assert.equal(result.error, true);
        assert.match(result.output, /Error: boom/);
    });

    it("times out unresolved async work", async () => {
        const sandbox = new MetaSandbox({
            never: () => new Promise(() => undefined),
        });

        const result = await sandbox.execute(`
await never();
`, { timeoutMs: 20 });

        assert.equal(result.error, true);
        assert.match(result.output, /Meta sandbox timeout/);
    });

    it("does not expose process by default", async () => {
        const sandbox = new MetaSandbox({});
        const result = await sandbox.execute(`
return typeof process;
`);

        assert.equal(result.error, false);
        assert.equal(result.output, "undefined");
    });
});