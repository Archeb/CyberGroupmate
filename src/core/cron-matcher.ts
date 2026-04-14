/**
 * cron-matcher.ts — 轻量级 cron 表达式匹配器
 *
 * 支持标准 5 字段 cron 表达式：分 时 日 月 星期
 * 支持: *, <star>/n, n, n-m, n,m
 */

/**
 * 检查 cron 表达式是否匹配指定时间
 * @param cronExpr - 5 字段 cron 表达式，如 "0 9 * * *"
 * @param date - 要检查的时间
 */
export function matchesCron(cronExpr: string, date: Date): boolean {
    const parts = cronExpr.trim().split(/\s+/);
    if (parts.length !== 5) return false;

    const minute = date.getMinutes();
    const hour = date.getHours();
    const dayOfMonth = date.getDate();
    const month = date.getMonth() + 1; // 1-12
    const dayOfWeek = date.getDay(); // 0=Sun

    return (
        matchField(parts[0], minute, 0, 59) &&
        matchField(parts[1], hour, 0, 23) &&
        matchField(parts[2], dayOfMonth, 1, 31) &&
        matchField(parts[3], month, 1, 12) &&
        matchField(parts[4], dayOfWeek, 0, 7) // 0 和 7 都表示周日
    );
}

function matchField(field: string, value: number, min: number, max: number): boolean {
    // 处理逗号分隔的多个值
    if (field.includes(",")) {
        return field.split(",").some(part => matchField(part.trim(), value, min, max));
    }

    // */n - 每 n 个
    if (field.startsWith("*/")) {
        const step = parseInt(field.slice(2), 10);
        if (isNaN(step) || step <= 0) return false;
        return value % step === 0;
    }

    // n-m - 范围
    if (field.includes("-")) {
        const [startStr, endStr] = field.split("-");
        const start = parseInt(startStr, 10);
        const end = parseInt(endStr, 10);
        if (isNaN(start) || isNaN(end)) return false;
        return value >= start && value <= end;
    }

    // * - 任意
    if (field === "*") return true;

    // 具体数值
    const num = parseInt(field, 10);
    if (isNaN(num)) return false;

    // 星期字段特殊处理：0 和 7 都是周日
    if (max === 7 && (num === 7 || num === 0)) {
        return value === 0 || value === 7;
    }

    return value === num;
}

/**
 * 验证 cron 表达式的最短触发间隔是否满足要求。
 * 简化实现：检查分钟字段是否会导致小于 minIntervalMinutes 的触发间隔。
 *
 * @param cronExpr - 5 字段 cron 表达式
 * @param minIntervalMinutes - 最短允许间隔（分钟）
 * @returns true = 满足最短间隔要求
 */
export function validateCronMinInterval(cronExpr: string, minIntervalMinutes: number): boolean {
    const parts = cronExpr.trim().split(/\s+/);
    if (parts.length !== 5) return false;

    const [minuteField, hourField] = parts;

    // 如果小时字段是 */n，检查 n（每 n 小时触发）
    if (hourField.startsWith("*/")) {
        const step = parseInt(hourField.slice(2), 10);
        if (!isNaN(step) && step >= 1) {
            return step * 60 >= minIntervalMinutes;
        }
    }

    // 如果小时字段是 *，则取决于分钟字段
    if (hourField === "*") {
        // 小时为 *，表示每小时都触发
        // 如果分钟是固定值或者间隔 >= minIntervalMinutes，那最小间隔是 60 分钟
        // 但如果分钟也是 *，则每分钟触发
        if (minuteField === "*") return false; // 每分钟
        if (minuteField.startsWith("*/")) {
            const step = parseInt(minuteField.slice(2), 10);
            // */n 在小时=* 时，每小时触发 60/n 次，间隔约 n 分钟，但跨小时间隔是 n 分钟
            // 实际最短间隔 = n 分钟
            return !isNaN(step) && step >= minIntervalMinutes;
        }
        // 固定分钟值 + 每小时 → 间隔 60 分钟
        return 60 >= minIntervalMinutes;
    }

    // 小时字段是固定值、范围或列表 → 至少间隔 1 小时（同小时内只触发一次或几次）
    // 保守起见，如果分钟字段是 * 或 */n 且间隔太短，也拒绝
    if (minuteField === "*" || (minuteField.startsWith("*/") && parseInt(minuteField.slice(2), 10) < minIntervalMinutes)) {
        // 同一小时内多次触发
        return false;
    }

    // 其他情况（固定小时+固定分钟）→ 至少间隔 1 小时
    return 60 >= minIntervalMinutes;
}
