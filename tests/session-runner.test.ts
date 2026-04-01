/**
 * session-runner.test.ts — CodeAct Session Runner 单元测试
 *
 * 主要测试 response 解析逻辑。完整的 session 运行需要集成测试。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseResponse } from "../src/sandbox/session-runner.js";

describe("parseResponse", () => {
    it("should parse thinking only (no code blocks)", () => {
        const response = "I'm done processing the request. Everything looks good.";
        const { thinking, codeBlocks } = parseResponse(response);

        assert.equal(codeBlocks.length, 0);
        assert.ok(thinking.includes("done processing"));
    });

    it("should parse a single typescript code block", () => {
        const response = `Let me send a message.

\`\`\`typescript
await telegram.sendText(-100123, "Hello!");
\`\`\`

That should work.`;

        const { thinking, codeBlocks } = parseResponse(response);

        assert.equal(codeBlocks.length, 1);
        assert.equal(codeBlocks[0].lang, "js");
        assert.equal(codeBlocks[0].code, 'await telegram.sendText(-100123, "Hello!");');
        assert.ok(thinking.includes("Let me send a message"));
        assert.ok(thinking.includes("That should work"));
    });

    it("should parse ts shorthand code block", () => {
        const response = `\`\`\`ts
console.log("hello")
\`\`\``;

        const { codeBlocks } = parseResponse(response);
        assert.equal(codeBlocks.length, 1);
        assert.equal(codeBlocks[0].lang, "js");
        assert.equal(codeBlocks[0].code, 'console.log("hello")');
    });

    it("should parse js code block", () => {
        const response = `\`\`\`js
const x = 42;
\`\`\``;

        const { codeBlocks } = parseResponse(response);
        assert.equal(codeBlocks.length, 1);
        assert.equal(codeBlocks[0].lang, "js");
    });

    it("should parse javascript code block", () => {
        const response = `\`\`\`javascript
const x = 42;
\`\`\``;

        const { codeBlocks } = parseResponse(response);
        assert.equal(codeBlocks.length, 1);
        assert.equal(codeBlocks[0].lang, "js");
    });

    it("should parse multiple code blocks", () => {
        const response = `First, let me get messages.

\`\`\`typescript
const msgs = await telegram.getMessages(-100123, { limit: 10 });
console.log(msgs.map(m => m.text));
\`\`\`

Now let me reply.

\`\`\`ts
await telegram.sendText(-100123, "Got it!");
\`\`\`

Done.`;

        const { thinking, codeBlocks } = parseResponse(response);

        assert.equal(codeBlocks.length, 2);
        assert.ok(codeBlocks[0].code.includes("getMessages"));
        assert.ok(codeBlocks[1].code.includes("sendText"));
        assert.equal(codeBlocks[0].lang, "js");
        assert.equal(codeBlocks[1].lang, "js");
        assert.ok(thinking.includes("First"));
        assert.ok(thinking.includes("Done"));
    });

    it("should ignore non-ts/js/bash code blocks", () => {
        const response = `Here's a Python example:

\`\`\`python
print("hello")
\`\`\`

And here's the actual code:

\`\`\`typescript
console.log("hello")
\`\`\``;

        const { codeBlocks } = parseResponse(response);
        assert.equal(codeBlocks.length, 1);
        assert.ok(codeBlocks[0].code.includes("console.log"));
        assert.equal(codeBlocks[0].lang, "js");
    });

    it("should handle multiline code blocks", () => {
        const response = `\`\`\`typescript
scene.enter("telegram");

const msgs = await telegram.getMessages(-100123, { limit: 5 });
for (const msg of msgs) {
  console.log(\`\${msg.sender.firstName}: \${msg.text}\`);
}
\`\`\``;

        const { codeBlocks } = parseResponse(response);
        assert.equal(codeBlocks.length, 1);
        assert.ok(codeBlocks[0].code.includes("scene.enter"));
        assert.ok(codeBlocks[0].code.includes("for (const msg"));
    });

    // ─── Bash code block tests ───

    it("should parse bash code block", () => {
        const response = `Let me download something.

\`\`\`bash
curl -s https://example.com/data.json -o /tmp/data.json
echo "downloaded"
\`\`\``;

        const { thinking, codeBlocks } = parseResponse(response);
        assert.equal(codeBlocks.length, 1);
        assert.equal(codeBlocks[0].lang, "bash");
        assert.ok(codeBlocks[0].code.includes("curl"));
        assert.ok(thinking.includes("download"));
    });

    it("should parse sh code block", () => {
        const response = `\`\`\`sh
ls -la /tmp
\`\`\``;

        const { codeBlocks } = parseResponse(response);
        assert.equal(codeBlocks.length, 1);
        assert.equal(codeBlocks[0].lang, "bash");
        assert.ok(codeBlocks[0].code.includes("ls -la"));
    });

    it("should parse shell code block", () => {
        const response = `\`\`\`shell
echo hello
\`\`\``;

        const { codeBlocks } = parseResponse(response);
        assert.equal(codeBlocks.length, 1);
        assert.equal(codeBlocks[0].lang, "bash");
    });

    it("should parse mixed js and bash code blocks preserving order and lang", () => {
        const response = `First fetch data with curl.

\`\`\`bash
curl -s https://api.example.com/info -o /tmp/info.json
\`\`\`

Now process it.

\`\`\`javascript
const fs = require("fs");
const data = JSON.parse(fs.readFileSync("/tmp/info.json", "utf-8"));
console.log(data.title);
\`\`\`

Done.`;

        const { codeBlocks } = parseResponse(response);
        assert.equal(codeBlocks.length, 2);
        assert.equal(codeBlocks[0].lang, "bash");
        assert.ok(codeBlocks[0].code.includes("curl"));
        assert.equal(codeBlocks[1].lang, "js");
        assert.ok(codeBlocks[1].code.includes("readFileSync"));
    });

});
