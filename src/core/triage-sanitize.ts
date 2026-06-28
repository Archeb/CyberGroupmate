/**
 * triage-sanitize.ts — 清洗 triage `reason` 里预写好的成句台词 / 金句。
 *
 * topic-triage 的 `reason` 只应描述方向（钩子 / 口吻 / 角度）供 Meta 判断；但模型常顺手把
 * 一句具体的吐槽 / 比喻 / 金句写进去。这句现成台词会被注入 Meta、抄进 contentDirection，
 * 再由回复模型原样发出，读起来工整刻意。本函数在 reason 流向下游前把成型的引号句子抹掉，
 * 只留方向性描述，强制具体措辞留到真正回复时临场发挥。
 *
 * 仅处理成对方向引号（“” ‘’ 「」『』）：开 ≠ 闭，内层排除闭引号，故每个开引号只配到最近的
 * 闭引号、不会跨串；短标签 / 实体名因不足长度阈值而保留。
 */

// 成对方向引号
const PAIRS: ReadonlyArray<readonly [string, string]> = [
    ["“", "”"],
    ["‘", "’"],
    ["「", "」"],
    ["『", "』"],
];

// 引导词（比如/调侃/吐槽…）—— 命中后保留引导词、抹掉其后的成句草稿
const LEADER =
    "(比如|例如|可以说|可以回|不妨|顺着|调侃|吐槽(?:一句|道)?|回(?:一)?句|接(?:一)?句|说(?:一)?句|盯(?:一?句|住|一下)?|怼(?:一)?句?|损(?:一)?句?|催(?:一)?句?|嫌弃式?(?:地?一句)?)\\s*[:：]?\\s*";

// 模式由常量拼成、永不变化：模块加载时预编译一次，避免每次调用（每话题每次 flush）重建 8 个 RegExp。
// 注意：用于 String.replace 的全局正则在每次 replace 后会把 lastIndex 复位为 0，复用安全。
const SANITIZE_RULES: ReadonlyArray<{ readonly leader: RegExp; readonly solo: RegExp }> = PAIRS.map(
    ([open, close]) => {
        const inner = `[^${close}]`;
        return {
            // 引导词 + 成句（≥4 字）→ 留引导词
            leader: new RegExp(`${LEADER}${open}${inner}{4,}${close}`, "g"),
            // 落单的成句引号（≥6 字，像整句而非短标签/实体名）→ 抹内容
            solo: new RegExp(`${open}${inner}{6,}${close}`, "g"),
        };
    },
);

export function sanitizeTriageReason(reason: string): string;
export function sanitizeTriageReason(reason: string | undefined): string | undefined;
export function sanitizeTriageReason(reason: string | undefined): string | undefined {
    if (!reason) return reason;
    let r = reason;
    for (const { leader, solo } of SANITIZE_RULES) {
        r = r.replace(leader, "$1（措辞临场发挥，勿照搬）");
        r = r.replace(solo, "（…）");
    }
    return r;
}
