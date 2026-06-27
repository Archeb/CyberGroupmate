/**
 * triage-sanitize.test.ts — sanitizeTriageReason 清洗预写金句的单元测试
 *
 * 规则回顾（见 src/core/triage-sanitize.ts）：
 *   - 4 种成对方向引号：“” ‘’ 「」『』
 *   - 引导词（调侃/吐槽/比如…）+ 成句(≥4 字) → 保留引导词、抹掉成句
 *   - 落单成句引号(≥6 字) → 整段抹成 （…）
 *   - 短标签 / 实体名（不足长度阈值）保留；无引号的方向描述原样保留
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeTriageReason } from "../src/core/triage-sanitize.js";

const KEEP_LEADER = "（措辞临场发挥，勿照搬）";
const STRIPPED = "（…）";

describe("sanitizeTriageReason", () => {
    // ─── 空值 / 透传 ───
    it("undefined / 空串 原样返回（重载保留 undefined）", () => {
        assert.equal(sanitizeTriageReason(undefined), undefined);
        assert.equal(sanitizeTriageReason(""), "");
    });

    it("无引号的纯方向描述原样保留（即便含引导词）", () => {
        const reason = "顺着对方话头调侃他的发型，口吻欠揍一点";
        assert.equal(sanitizeTriageReason(reason), reason);
    });

    // ─── 引导词 + 成句 → 保留引导词、抹成句（阈值 ≥4） ───
    it("引导词 + 成句（≥4 字）→ 保留引导词，抹掉具体台词", () => {
        assert.equal(sanitizeTriageReason("调侃“你这操作真骚啊”"), `调侃${KEEP_LEADER}`);
    });

    it("引导词把成句阈值降到 4 字（短到 4 字也被抹）", () => {
        assert.equal(sanitizeTriageReason("吐槽“菜就多练”"), `吐槽${KEEP_LEADER}`);
    });

    it("引导词与引号间的冒号/空格被吃掉、不进入保留部分", () => {
        assert.equal(sanitizeTriageReason("吐槽：“菜就多练几把”"), `吐槽${KEEP_LEADER}`);
        assert.equal(sanitizeTriageReason("比如 “这也能翻车”"), `比如${KEEP_LEADER}`);
    });

    // ─── 落单成句（无引导词，阈值 ≥6） ───
    it("落单成句引号（≥6 字）→ 整段抹成 （…）", () => {
        assert.equal(sanitizeTriageReason("他说“今天天气真不错啊”很开心"), `他说${STRIPPED}很开心`);
    });

    it("同串多个落单成句各自被抹", () => {
        assert.equal(
            sanitizeTriageReason("“句子一这边的内容”和“句子二那边的内容”"),
            `${STRIPPED}和${STRIPPED}`,
        );
    });

    // ─── 短标签 / 实体名保留（落单且 <6 字） ───
    it("落单短标签（<6 字、无引导词）保留，不误伤实体名/梗名", () => {
        assert.equal(sanitizeTriageReason("用了「细狗」这个标签"), "用了「细狗」这个标签");
        assert.equal(sanitizeTriageReason("提到“摆烂”"), "提到“摆烂”");
    });

    // ─── 4 种引号都覆盖 ───
    it("‘’ 引导词成句", () => {
        assert.equal(sanitizeTriageReason("不妨‘随便说两句’"), `不妨${KEEP_LEADER}`);
    });

    it("『』 落单成句", () => {
        assert.equal(sanitizeTriageReason("他写道『长长的一句话内容』"), `他写道${STRIPPED}`);
    });

    it("「」 落单成句", () => {
        assert.equal(sanitizeTriageReason("引用「这是一句完整的话」收尾"), `引用${STRIPPED}收尾`);
    });

    // ─── 每个开引号只配到最近的闭引号、不跨串 ───
    it("成句内部不吞掉后续闭引号（最近匹配）", () => {
        // 第一段“……”被抹，"中间"是落单短标签保留，第二段不存在
        const out = sanitizeTriageReason("开头“前面这句够长了吧”中间“后面这句也够长”结尾");
        assert.equal(out, `开头${STRIPPED}中间${STRIPPED}结尾`);
    });
});
