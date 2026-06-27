/**
 * end-reason-status.test.ts — session endReason → 派发任务终态映射
 *
 * 覆盖 commit cb84af9 的执行器侧映射：interrupted 是「让路」而非失败，必须落 SKIPPED，
 * 不能被误记为 COMPLETED；error→ERROR；正常收尾→COMPLETED。
 * （TIMEOUT 由 GlobalState 启动对账补写，不在此函数产生——见 s6-global-state.test.ts。）
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { endReasonToTaskStatus } from "../src/subagent/code-act-executor.js";

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
