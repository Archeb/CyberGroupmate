/**
 * end-reason-status.test.ts — session endReason → 派发任务终态映射
 *
 * endReasonToTaskStatus：纯 endReason 映射（interrupted 是「让路」非失败→SKIPPED；error→ERROR；正常收尾→COMPLETED）。
 * classifyDispatchedTaskStatus：在其上叠加运行时信息——超时从 ERROR 拆出为 TIMEOUT；
 *   正常收尾但整轮没有任何对外动作（没发消息、没贴表态）→ SKIPPED（"想过但决定不回复"）。
 * （进程中途退出残留 RUNNING/PENDING 的 TIMEOUT 由 GlobalState 启动对账补写——见 s6-global-state.test.ts。）
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { endReasonToTaskStatus, classifyDispatchedTaskStatus } from "../src/subagent/code-act-executor.js";

describe("endReasonToTaskStatus", () => {
    it("interrupted → SKIPPED（被新消息/用户打断，主动让路非失败）", () => {
        assert.equal(endReasonToTaskStatus("interrupted"), "SKIPPED");
    });

    it("error → ERROR", () => {
        assert.equal(endReasonToTaskStatus("error"), "ERROR");
    });

    it("end_turn → COMPLETED（正常收尾）", () => {
        assert.equal(endReasonToTaskStatus("end_turn"), "COMPLETED");
    });

    it("max_turns → COMPLETED（跑满轮数也算完成，非失败）", () => {
        assert.equal(endReasonToTaskStatus("max_turns"), "COMPLETED");
    });

    it("undefined / 未知 endReason → COMPLETED（兜底不误判为失败）", () => {
        assert.equal(endReasonToTaskStatus(undefined), "COMPLETED");
        assert.equal(endReasonToTaskStatus("something-else"), "COMPLETED");
    });

    it("永不产出 TIMEOUT（TIMEOUT 仅由启动对账补写）", () => {
        for (const r of ["interrupted", "error", "end_turn", "max_turns", undefined]) {
            assert.notEqual(endReasonToTaskStatus(r), "TIMEOUT");
        }
    });
});

describe("classifyDispatchedTaskStatus", () => {
    it("正常收尾但没有任何对外动作 → SKIPPED（想过但决定不回复）", () => {
        assert.equal(classifyDispatchedTaskStatus("end_turn", { producedOutput: false }), "SKIPPED");
        assert.equal(classifyDispatchedTaskStatus("max_turns", { producedOutput: false }), "SKIPPED");
    });

    it("正常收尾且发了消息/贴了表态 → COMPLETED", () => {
        assert.equal(classifyDispatchedTaskStatus("end_turn", { producedOutput: true }), "COMPLETED");
    });

    it("error 且错误为超时 → TIMEOUT，否则 → ERROR", () => {
        assert.equal(classifyDispatchedTaskStatus("error", { producedOutput: false, error: "Code execution timed out after 60000ms" }), "TIMEOUT");
        assert.equal(classifyDispatchedTaskStatus("error", { producedOutput: false, error: "boom" }), "ERROR");
        assert.equal(classifyDispatchedTaskStatus("error", { producedOutput: false }), "ERROR");
    });

    it("interrupted → SKIPPED（让路语义优先，不受 producedOutput 影响）", () => {
        assert.equal(classifyDispatchedTaskStatus("interrupted", { producedOutput: true }), "SKIPPED");
        assert.equal(classifyDispatchedTaskStatus("interrupted", { producedOutput: false }), "SKIPPED");
    });
});
