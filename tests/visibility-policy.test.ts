/**
 * tests/visibility-policy.test.ts — 全局 visibility 兜底（纯函数，确定性、无 DB）
 *
 * 覆盖：getChatVisibility 分级、R2 egress 拦截、R1 显式读拦截、聚合 scrub（行 / fact）、
 * 以及 enforce: block | warn | off 三种模式的行为差异。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    assertEgressAllowed,
    getChatVisibility,
    isExplicitReadBlocked,
    isPrivateChat,
    scrubFactsByVisibility,
    scrubRowsByVisibility,
    VisibilityViolationError,
    type EnforceMode,
    type PolicyContext,
    type VisibilityDeps,
} from "../src/core/visibility-policy.js";
import { scrubIdentityMatches } from "../src/meta-sandbox/meta-api/memory.js";
import { createPrivacyApi } from "../src/meta-sandbox/meta-api/privacy.js";
import { gatePrivacyMarkSensitive } from "../src/sandbox/modules/module-registry.js";

const BOUND = "telegram:-100bound";   // 当前绑定（shared 群）
const SHARED = "telegram:-100shared"; // 另一个普通群
const DM = "telegram:dmUser";         // 私聊
const MARKED = "telegram:-100marked"; // 运行时标记为敏感的群
const SEED = "telegram:-100seed";     // 配置种子敏感群

function makeDeps(overrides?: Partial<VisibilityDeps>): VisibilityDeps {
    const groupModels: Record<string, { isDirectMessage?: boolean; markedSensitive?: boolean }> = {
        [BOUND]: {},
        [SHARED]: {},
        [DM]: { isDirectMessage: true },
        [MARKED]: { markedSensitive: true },
        [SEED]: {},
    };
    return {
        getGroupModel: (key) => groupModels[key] ?? null,
        sensitiveSeed: new Set([SEED]),
        dmAutoPrivate: true,
        ...overrides,
    };
}

function ctx(boundChatId: string, enforce: EnforceMode, deps = makeDeps(), onViolation?: PolicyContext["onViolation"]): PolicyContext {
    return { boundChatId, enforce, deps, onViolation };
}

describe("getChatVisibility — 分级", () => {
    it("普通群 = shared；DM / marked / 配置种子 = private", () => {
        const deps = makeDeps();
        assert.equal(getChatVisibility(SHARED, deps), "shared");
        assert.equal(getChatVisibility(DM, deps), "private");
        assert.equal(getChatVisibility(MARKED, deps), "private");
        assert.equal(getChatVisibility(SEED, deps), "private");
        assert.equal(isPrivateChat(DM, deps), true);
        assert.equal(isPrivateChat(SHARED, deps), false);
    });

    it("dmAutoPrivate=false 时 DM 不再自动私密", () => {
        const deps = makeDeps({ dmAutoPrivate: false });
        assert.equal(getChatVisibility(DM, deps), "shared");
        // 但 marked / seed 仍然私密
        assert.equal(getChatVisibility(MARKED, deps), "private");
        assert.equal(getChatVisibility(SEED, deps), "private");
    });

    it("空 chatId 视作 shared", () => {
        assert.equal(getChatVisibility(undefined, makeDeps()), "shared");
        assert.equal(getChatVisibility("", makeDeps()), "shared");
    });

    it("种子可用裸 rawId 命中 composite chatId（兼容裸 rawId / 文档写法）", () => {
        const deps = makeDeps({ sensitiveSeed: new Set(["-1001234567890"]) });
        assert.equal(isPrivateChat("telegram:-1001234567890", deps), true);
        // composite 种子同样命中
        const deps2 = makeDeps({ sensitiveSeed: new Set(["telegram:-1001234567890"]) });
        assert.equal(isPrivateChat("telegram:-1001234567890", deps2), true);
        // 不相关 chat 仍 shared
        assert.equal(isPrivateChat("telegram:-100other", deps), false);
    });
});

describe("R2 — egress 写/派发拦截", () => {
    it("绑定在私聊时，向别的会话发送 → block 抛错；warn 不抛但告警；off 放行", () => {
        let warned = 0;
        assert.throws(
            () => assertEgressAllowed("egress-write", "telegram.sendText", SHARED, ctx(DM, "block")),
            VisibilityViolationError,
        );
        assert.doesNotThrow(
            () => assertEgressAllowed("egress-write", "telegram.sendText", SHARED, ctx(DM, "warn", makeDeps(), () => { warned++; })),
        );
        assert.equal(warned, 1);
        assert.doesNotThrow(
            () => assertEgressAllowed("egress-write", "telegram.sendText", SHARED, ctx(DM, "off")),
        );
    });

    it("绑定在普通群时，向别的普通群发送 → 放行（保留跨群编排）", () => {
        assert.doesNotThrow(
            () => assertEgressAllowed("egress-write", "telegram.sendText", SHARED, ctx(BOUND, "block")),
        );
    });

    it("发给自己（target == bound）始终放行", () => {
        assert.doesNotThrow(
            () => assertEgressAllowed("egress-write", "telegram.sendText", DM, ctx(DM, "block")),
        );
    });

    it("dispatch：bound 或 target 任一私密且 ≠ 对方 → 拦截", () => {
        // 普通群 → 私密群：target 私密 → 拦截
        assert.throws(
            () => assertEgressAllowed("egress-dispatch", "dispatch.taskToGroup", MARKED, ctx(BOUND, "block")),
            VisibilityViolationError,
        );
        // 私密群 → 普通群：bound 私密 → 拦截
        assert.throws(
            () => assertEgressAllowed("egress-dispatch", "dispatch.taskToGroup", BOUND, ctx(DM, "block")),
            VisibilityViolationError,
        );
        // 普通群 → 普通群：放行
        assert.doesNotThrow(
            () => assertEgressAllowed("egress-dispatch", "dispatch.taskToGroup", SHARED, ctx(BOUND, "block")),
        );
    });

    it("egress-write 不因 target 私密而拦截（只看 bound）", () => {
        // 普通群 → 私聊：直接 send 进别人私聊不是本兜底的目标，放行（由现有 restrictAdapterWrites 等管）
        assert.doesNotThrow(
            () => assertEgressAllowed("egress-write", "telegram.sendText", DM, ctx(BOUND, "block")),
        );
    });
});

describe("R1 — 显式读拦截", () => {
    it("显式请求别的私密会话 → block 返回 true（应返回空）；warn / off / 同会话 / shared → false", () => {
        assert.equal(isExplicitReadBlocked(DM, ctx(BOUND, "block")), true);
        assert.equal(isExplicitReadBlocked(DM, ctx(BOUND, "warn")), false);
        assert.equal(isExplicitReadBlocked(DM, ctx(BOUND, "off")), false);
        assert.equal(isExplicitReadBlocked(DM, ctx(DM, "block")), false); // 就是当前会话
        assert.equal(isExplicitReadBlocked(SHARED, ctx(BOUND, "block")), false); // shared 可读
    });
});

describe("R1 — 聚合 scrub", () => {
    it("scrubRowsByVisibility 丢弃来源私密且 ≠ bound 的行；保留自身与 shared", () => {
        const rows = [
            { id: 1, chatId: BOUND },
            { id: 2, chatId: SHARED },
            { id: 3, chatId: DM },      // 跨私聊 → 丢
            { id: 4, chatId: MARKED },  // 跨敏感群 → 丢
        ];
        const res = scrubRowsByVisibility(rows, (r) => r.chatId, ctx(BOUND, "block"));
        assert.deepEqual(res.kept.map((r) => r.id), [1, 2]);
        assert.equal(res.dropped, 2);
    });

    it("warn 模式：不丢，但 onViolation 报告 flagged 数", () => {
        let reported = 0;
        const rows = [{ id: 1, chatId: DM }, { id: 2, chatId: BOUND }];
        const res = scrubRowsByVisibility(rows, (r) => r.chatId, ctx(BOUND, "warn", makeDeps(), () => { reported++; }));
        assert.equal(res.kept.length, 2);
        assert.equal(res.dropped, 0);
        assert.equal(reported, 1);
    });

    it("off 模式：原样返回", () => {
        const rows = [{ id: 1, chatId: DM }];
        const res = scrubRowsByVisibility(rows, (r) => r.chatId, ctx(BOUND, "off"));
        assert.equal(res.kept.length, 1);
    });

    it("scrubFactsByVisibility: 丢弃 fact 级 private 或来源会话私密(DM/marked) 的跨会话 fact；保留本会话与跨 shared 群", () => {
        const facts = [
            { factId: "a", visibility: "private" as const, sourceChatId: DM },        // 跨会话 + 私密标记 → 丢
            { factId: "b", visibility: "private" as const, sourceChatId: BOUND },     // 本会话 → 留
            { factId: "c", visibility: "contextual" as const, sourceChatId: DM },     // 来源 DM 私密 → 丢（#1 修复点）
            { factId: "d", visibility: "public" as const, sourceChatId: SHARED },     // 跨 shared 群 → 留
            { factId: "e", visibility: "contextual" as const, sourceChatId: SHARED }, // 跨 shared 群普通 fact → 留
            { factId: "f", visibility: "contextual" as const, sourceChatId: MARKED }, // 来源敏感群 → 丢
        ];
        const res = scrubFactsByVisibility(facts, ctx(BOUND, "block"));
        assert.deepEqual(res.kept.map((f) => f.factId), ["b", "d", "e"]);
        assert.equal(res.dropped, 3);
    });
});

describe("scrubIdentityMatches — profile.recentFacts 旁路泄露兜底", () => {
    it("擦除 match.profile.recentFacts 里来自私密会话的 fact", () => {
        const matches: any[] = [{
            profile: {
                recentFacts: [
                    { factId: "x", visibility: "contextual", sourceChatId: DM },     // 来源 DM → 丢
                    { factId: "y", visibility: "contextual", sourceChatId: SHARED }, // 跨 shared → 留
                    { factId: "z", visibility: "private", sourceChatId: SHARED },    // 标 private → 丢
                ],
            },
        }];
        scrubIdentityMatches(matches, ctx(BOUND, "block"));
        assert.deepEqual(matches[0].profile.recentFacts.map((f: any) => f.factId), ["y"]);
    });

    it("profile 缺失 recentFacts 不报错", () => {
        const matches: any[] = [{ profile: {} }, { profile: null }, {}];
        scrubIdentityMatches(matches, ctx(BOUND, "block"));
        assert.ok(true);
    });
});

describe("privacy.markSensitive 开关 (allowLlmMarkSensitive)", () => {
    const fakeMemory: any = {
        getGroupModel: () => null,
        markChatSensitive: (chatId: string, reason?: string) => ({ chatId, markedSensitive: true, sensitiveReason: reason }),
    };
    const deps = () => makeDeps();

    it("allow=false → markSensitive 抛错（仅管理员可配）", async () => {
        const api = createPrivacyApi(fakeMemory, deps, () => false);
        await assert.rejects(() => api.markSensitive("telegram:-100x", "r"), /禁用/);
    });

    it("allow=true → markSensitive 正常生效", async () => {
        const api = createPrivacyApi(fakeMemory, deps, () => true);
        const r = await api.markSensitive("telegram:-100x", "r");
        assert.equal(r.markedSensitive, true);
    });

    it("未传 getAllowMark → 默认允许（向后兼容）", async () => {
        const api = createPrivacyApi(fakeMemory, deps);
        const r = await api.markSensitive("telegram:-100x", "r");
        assert.equal(r.markedSensitive, true);
    });

    it("status 只读，不受开关影响", async () => {
        const api = createPrivacyApi(fakeMemory, deps, () => false);
        const s = await api.status("telegram:-100x");
        assert.equal(s.chatId, "telegram:-100x");
    });
});

describe("gatePrivacyMarkSensitive — 禁用时不向 LLM 概览注入 markSensitive", () => {
    const reg: any[] = [
        { name: "privacy", description: "", methods: [
            { name: "markSensitive", brief: "", fullDoc: "" },
            { name: "status", brief: "", fullDoc: "" },
        ] },
        { name: "memory", description: "", methods: [{ name: "searchFacts", brief: "", fullDoc: "" }] },
    ];

    it("allow=true → 原样返回（含 markSensitive）", () => {
        const out = gatePrivacyMarkSensitive(reg as any, true);
        assert.equal(out, reg);
    });

    it("allow=false → 剔除 privacy.markSensitive，保留 status 与其它模块", () => {
        const out = gatePrivacyMarkSensitive(reg as any, false);
        const privacy = out.find((m) => m.name === "privacy");
        assert.deepEqual(privacy?.methods.map((m) => m.name), ["status"]);
        assert.equal(out.find((m) => m.name === "memory")?.methods.length, 1);
        // 原注册表不被修改（返回的是副本）
        assert.equal(reg[0].methods.length, 2);
    });
});

describe("Meta 视角（boundChatId = 空）", () => {
    it("任何私密会话的行都被 scrub（meta 无当前会话）", () => {
        const rows = [{ chatId: DM }, { chatId: MARKED }, { chatId: SHARED }];
        const res = scrubRowsByVisibility(rows, (r) => r.chatId, ctx("", "block"));
        assert.deepEqual(res.kept.map((r) => r.chatId), [SHARED]);
    });
});
