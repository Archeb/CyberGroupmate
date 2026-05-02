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
});
