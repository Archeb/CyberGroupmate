import { it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStoreV2 } from "../src/memory-v2/memory-v2.js";
import { buildMessageSnapshot } from "../src/memory-v2/message-snapshot.js";
import { formatMessageLine } from "../src/core/message-enricher.js";
import { outgoingOneBotMentions } from "../src/core/onebot-mentions.js";
import { groundedIdentityUpdate } from "../src/memory-v2/identity-evidence.js";
import { OneBotAdapter } from "../src/adapter/onebot-adapter.js";
import { NotificationCenter } from "../src/event/notification-center.js";
import { ContextEngine } from "../src/context-engine/context-engine.js";
import { getExecutorTaskProviders } from "../src/context-engine/providers/executor-providers.js";

const chatId = "onebot:group:42";
const original = { messageId: "1", chatId, userId: "onebot:111", displayName: "Noah/Alice", text: "@Noah /今日猪猪", timestamp: "2026-09-01T00:00:00Z" };

it("preserves unknown legacy mentions and distinguishes real mentions from text across database reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "identity-mentions-"));
    const file = join(dir, "memory.db");
    let memory = new MemoryStoreV2(file);
    try {
        memory.storeMessageBatch([original]);
        memory.close();
        const legacy = new Database(file);
        legacy.exec("ALTER TABLE message_log DROP COLUMN mentions");
        legacy.close();
        memory = new MemoryStoreV2(file);
        const mentions = [{ userId: "onebot:222" }];
        memory.storeMessageBatch([
            { ...original, messageId: "2", mentions: [] },
            { ...original, messageId: "3", mentions, replyToMessageId: "2" },
        ]);
        // Delayed recording must not replace the original author or drop actual mention evidence.
        memory.storeMessageBatch([{ ...original, messageId: "3", userId: "onebot:999" }]);
        assert.equal(memory.getMessageById(chatId, "1")?.mentions, undefined);
        assert.deepEqual(memory.getMessageById(chatId, "2")?.mentions, []);
        const readers = [
            memory.getRecentMessages(chatId, 10),
            memory.getMessagesByIds(chatId, ["3"]),
            memory.getMessagesBetweenIds(chatId, "1", "3"),
            memory.queryMessages({ chatIds: [chatId] }),
            buildMessageSnapshot(memory.db, chatId, "2026-09-01T00:01:00Z", null).messages,
        ];
        for (const rows of readers) {
            const row = rows.find(message => message.messageId === "3");
            assert.equal(row?.userId, "onebot:111");
            assert.equal(row?.replyToMessageId, "2");
            assert.deepEqual(row?.mentions, mentions);
        }
    } finally {
        memory.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

it("keeps sender, reply author and mention target distinct even with identical labels", () => {
    const line = formatMessageLine({ id: "3", sender: "Noah", userId: "onebot:111", text: "@Noah 看看", replyTo: "Noah", replyToUserId: "onebot:222", replyToMsgId: "2", mentions: [{ userId: "onebot:333" }] });
    assert.match(line, /Noah \[userId:onebot:111\]/);
    assert.match(line, /reply to Noah \[userId:onebot:222\] #2/);
    assert.match(line, /mentions:onebot:333/);
    assert.match(formatMessageLine({ text: "@Noah /cmd", mentions: [] }), /mentions:none/);
    assert.match(formatMessageLine({ text: "@Noah /cmd" }), /mentions:unknown/);
});

it("rejects nickname-derived aliases, peer testimony and quoted self-claims without renaming platform identities", () => {
    const proposal = { displayName: "Other person", aliases: ["Noah", "Alice"] };
    assert.deepEqual(groundedIdentityUpdate("onebot:111", proposal, [{ ...original, userId: "onebot:222", text: "叫我Noah" }]), {});
    assert.deepEqual(groundedIdentityUpdate("onebot:111", proposal, [{ ...original, text: "他说：叫我Noah" }]), {});
    assert.deepEqual(groundedIdentityUpdate("onebot:111", proposal, [{ ...original, text: "Noah 刚发了通报" }]), {});
    assert.deepEqual(groundedIdentityUpdate("onebot:111", proposal, [{ ...original, text: "叫我Alice" }], ["Existing"]), { aliases: ["Existing", "Alice"] });
});

it("does not inherit unrelated or unscoped Meta claims into a chat executor", () => {
    const engine = new ContextEngine("identity-digest-boundary");
    engine.registerAll(getExecutorTaskProviders());
    const result = engine.render({ chatId, taskId: "test", decisions: [], sessionDigests: [
        { createdAt: "now", content: "foreign claim", actorType: "meta", sourceChatId: "__meta__", targetChatId: "onebot:group:99" },
        { createdAt: "now", content: "unscoped claim", actorType: "meta" },
        { createdAt: "now", content: "local claim", actorType: "meta", sourceChatId: "__meta__", targetChatId: chatId },
    ] });
    assert.match(result.historicalContent, /local claim/);
    assert.doesNotMatch(result.historicalContent, /foreign claim|unscoped claim/);
});

it("blocks accidental text @ before sending and preserves CQ mentions when adding a reply", async () => {
    const nc = new NotificationCenter(join(tmpdir(), "unused-identity-mention-events.jsonl"), false);
    const adapter = new OneBotAdapter({ wsUrl: "ws://127.0.0.1:1", selfId: "999" }, nc);
    const calls: Array<{ action: string; params: any }> = [];
    (adapter as any).callAction = async (action: string, params: any) => { calls.push({ action, params }); return { message_id: 5 }; };
    try {
        await assert.rejects((adapter as any).sendMessage(chatId, "@Noah /今日猪猪", {}), /只有文字 @/);
        await assert.rejects((adapter as any).sendAt(chatId, "Noah", "/cmd", {}), /不能使用昵称/);
        await assert.rejects((adapter as any).sendAt(chatId, "onebot:group:111", "/cmd", {}), /不能传入群/);
        await assert.rejects((adapter as any).callNapCatNativeAction("send_group_msg", { group_id: 42, message: "@Noah /cmd" }), /只有文字 @/);
        assert.equal(calls.length, 0);
        const ack = await (adapter as any).sendMessage(chatId, "[CQ:at,qq=222] /cmd", { replyTo: "1" });
        assert.deepEqual(calls[0].params.message, [
            { type: "reply", data: { id: "1" } }, { type: "at", data: { qq: "222" } }, { type: "text", data: { text: " /cmd" } },
        ]);
        assert.deepEqual(ack.mentions, [{ userId: "onebot:222" }]);
        assert.equal(ack.senderUserId, "onebot:999");
        const literal = await (adapter as any).sendMessage(chatId, [{ type: "text", data: { text: "@Noah /cmd" } }], {});
        assert.deepEqual(literal.mentions, []);
        assert.deepEqual(outgoingOneBotMentions("[CQ:at,name=Noah,qq=222]"), [{ userId: "onebot:222" }]);
        assert.deepEqual(outgoingOneBotMentions("[CQ:at,qq=222]", true), []);
        assert.deepEqual(outgoingOneBotMentions([{ type: "text", data: { text: "[CQ:at,qq=222]" } }]), []);
    } finally { nc.dispose(); }
});
