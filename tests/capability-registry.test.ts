import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { installCapabilityRegistry } from "../src/sandbox/capability-registry.js";

describe("installCapabilityRegistry", () => {
    it("should install runtime, memory, actions, skills, scene and telegram", async () => {
        const outputs: string[] = [];
        const notifications: Array<Record<string, unknown>> = [];
        const hostCalls: Array<{ method: string; args?: unknown[] }> = [];
        const ctx: Record<string, unknown> = {};
        let currentScene = "home";

        const capabilities = installCapabilityRegistry({
            ctx,
            emitOutput: (line) => outputs.push(line),
            notifyHost: (event) => notifications.push(event),
            requestInput: async (prompt) => `answer:${prompt}`,
            printToHost: (message) => outputs.push(`[print] ${message}`),
            spawnTask: () => {},
            killTask: () => {},
            listTasks: () => ["task-a"],
            callHost: async (method, args = []) => {
                hostCalls.push({ method, args });
                switch (method) {
                    case "memory.recall":
                        return { topics: [], facts: [], persons: [] };
                    case "actions.getTopicContext":
                        return { id: String(args[0]), label: "topic" };
                    case "telegram.sendText":
                        return {
                            id: "msg_1",
                            chat: { id: String(args[0]), type: "private" },
                            text: String(args[1]),
                            date: "2026-03-08T00:00:00.000Z",
                        };
                    case "telegram.getMe":
                        return { id: "42", firstName: "Cyber", isBot: true };
                    case "telegram.sendTyping":
                        return null;
                    default:
                        return null;
                }
            },
        }) as {
            runtime: Record<string, unknown>;
            memory: Record<string, unknown>;
            actions: Record<string, unknown>;
            skills: Record<string, unknown>;
            scene: Record<string, unknown>;
            telegram: Record<string, unknown>;
        };

        assert.ok(capabilities.telegram);
        assert.equal(typeof capabilities.runtime.notify, "function");
        assert.equal(typeof capabilities.memory.recall, "function");
        assert.equal(typeof capabilities.actions.getTopicContext, "function");
        assert.equal(typeof capabilities.skills.social, "object");
        assert.equal(typeof capabilities.scene.enter, "function");

        const tg = capabilities.telegram as { sendText: (chatId: string, text: string) => Promise<unknown>; sendTyping: (chatId: string) => Promise<void> };
        await tg.sendTyping("100");
        const sent = await tg.sendText("100", "hello");
        assert.equal((sent as { id: string }).id, "msg_1");
        assert.ok(outputs.some(line => line.includes("[Telegram] sendTyping ok chat=100")));
        assert.ok(outputs.some(line => line.includes("[Telegram] sendText ok chat=100 msg=msg_1 text=hello")));

        const skills = capabilities.skills as {
            social: { replyInTelegram: (chatId: string, text: string) => Promise<unknown> };
        };
        await skills.social.replyInTelegram("100", "world");
        assert.ok(notifications.some(event => event.type === "system.agent_message_sent"));

        const scene = capabilities.scene as {
            enter: (name: string, focus?: { chatId?: string }) => void;
            focus: (focus: { scene?: string; chatId?: string }) => void;
            current: string;
        };
        assert.throws(() => scene.enter("telegram", { chatId: "100" }), /Scene transition requested/);
        assert.equal(scene.current, "telegram");
        assert.ok(outputs.some(line => line.includes("[Scene switched to: telegram focus=")));
        assert.deepEqual(ctx.__sceneFocus, { scene: "telegram", chatId: "100" });

        assert.throws(() => scene.focus({ scene: "memory", chatId: "100" }), /Scene transition requested/);
        assert.equal(scene.current, "memory");

        assert.ok(hostCalls.some(call => call.method === "telegram.sendText"));
        assert.ok(hostCalls.some(call => call.method === "memory.recall") === false);
    });
});
