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
