import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MetaSandbox } from "../src/meta-sandbox/meta-sandbox.js";

describe("MetaSandbox session scope", () => {
    it("keeps top-level const values for one session and allows redeclare", async () => {
        const sandbox = new MetaSandbox({});
        sandbox.beginSession("s1");

        const first = await sandbox.execute("const result = 41; console.log(result)");
        assert.equal(first.error, false);
        assert.equal(first.output, "[log] 41");

        const second = await sandbox.execute("const result = result + 1; console.log(result)");
        assert.equal(second.error, false);
        assert.equal(second.output, "[log] 42");

        const third = await sandbox.execute("console.log(result)");
        assert.equal(third.error, false);
        assert.equal(third.output, "[log] 42");

        sandbox.endSession("s1");
        const after = await sandbox.execute("console.log(typeof result)");
        assert.equal(after.error, false);
        assert.equal(after.output, "[log] undefined");
    });

    it("does not let session locals shadow api globals", async () => {
        const sandbox = new MetaSandbox({
            agents: {
                listStatus: async () => [{ chatId: "telegram:-1001", chatTitle: "早苗基金会" }],
            },
        });
        sandbox.beginSession("s1");

        const first = await sandbox.execute(`
const agents = await agents.listStatus();
console.log(JSON.stringify(agents));
`);
        assert.equal(first.error, false);
        assert.match(first.output, /早苗基金会/);

        const second = await sandbox.execute(`
const again = await agents.listStatus();
console.log(JSON.stringify(again));
`);
        assert.equal(second.error, false);
        assert.match(second.output, /早苗基金会/);

        const third = await sandbox.execute(`
agents = [];
console.log(typeof agents.listStatus);
`);
        assert.equal(third.error, false);
        assert.equal(third.output, "[log] function");
    });

    it("emits meta-api call observations even without console.log", async () => {
        const sandbox = new MetaSandbox({
            dispatch: {
                taskToGroup: async () => ({ taskId: "task-42", status: "PENDING" }),
            },
        });
        sandbox.beginSession("s1");

        const result = await sandbox.execute("await dispatch.taskToGroup('telegram:g1', { contentDirection: 'reply' });");
        assert.equal(result.error, false);
        assert.match(result.output, /\[log\] \[meta-api\] dispatch.taskToGroup ->/);
        assert.match(result.output, /task-42/);
    });
});
