/**
 * minicodeact-formatter.ts — MiniCodeAct 结果格式化工具
 *
 * 将 MiniCodeActResult[] 格式化为人类可读的报告文本，
 * 用于注入到 MINI_CODE_ACT_REPORT prompt 模板的 {{results}} 变量。
 */

import type { MiniCodeActResult } from "../subagent/types.js";

/**
 * 格式化 MiniCodeAct 执行结果为可读报告。
 *
 * 输出示例：
 * ```
 * ✅ memory.writeCoreFact → 已写入核心事实: user_456 "对花生严重过敏" [biographical]
 * ❌ attention.boost → 失败: 目标群组不存在
 * ```
 */
export function formatMiniCodeActReport(results: MiniCodeActResult[]): string {
    if (results.length === 0) {
        return "(无操作)";
    }

    return results
        .map((r) => {
            const icon = r.success ? "✅" : "❌";
            const detail = r.success ? r.summary : `失败: ${r.error ?? r.summary}`;
            return `${icon} ${r.call} → ${detail}`;
        })
        .join("\n");
}
