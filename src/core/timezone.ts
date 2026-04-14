/**
 * timezone.ts — 全局时区工具
 *
 * 存储层始终使用 UTC（Date.toISOString()）。
 * 本模块仅在"渲染给 LLM 看"的 prompt 拼接处提供本地化时间格式。
 */

let _globalTimezone: string | undefined;

/**
 * 设置全局时区（启动时由 main.ts 调用一次）。
 * 同时设置 process.env.TZ，使 Date 的本地时间方法（getHours 等）
 * 统一使用配置时区，确保 cron 匹配、remind 触发等均基于该时区。
 * @param tz - IANA 时区标识符，例如 "Asia/Shanghai"
 */
export function setGlobalTimezone(tz: string | undefined): void {
    _globalTimezone = tz;
    if (tz) {
        process.env.TZ = tz;
    }
}

/**
 * 获取全局时区
 * @returns IANA 时区标识符，未设置时返回 undefined（将 fallback 到系统时区）
 */
export function getGlobalTimezone(): string | undefined {
    return _globalTimezone;
}

/**
 * 将 UTC ISO 时间戳格式化为带时区偏移的人类可读字符串
 *
 * 用于拼入 LLM prompt，让模型看到的时间与 agent "生活"的时区一致。
 *
 * @param isoUtc - UTC ISO 8601 时间戳，如 "2026-03-18T01:05:13.000Z"
 * @param tz - 可选，覆盖全局时区
 * @returns 格式如 "2026-03-18 09:05:13 +08:00"，输入为空/无效时原样返回
 */
export function formatTsForDisplay(isoUtc: string | undefined | null, tz?: string): string {
    if (!isoUtc) return "";
    try {
        const date = new Date(isoUtc);
        if (isNaN(date.getTime())) return isoUtc;

        const timezone = tz ?? _globalTimezone;
        // 使用 Intl.DateTimeFormat 获取各字段
        const fmt = new Intl.DateTimeFormat("sv-SE", {
            timeZone: timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        });
        const parts = fmt.formatToParts(date);
        const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
        const dateStr = `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;

        // 计算 UTC 偏移
        const offset = getUtcOffset(date, timezone);

        return `${dateStr} ${offset}`;
    } catch {
        // 解析失败时原样返回
        return isoUtc;
    }
}

/**
 * 计算指定时区在给定时刻的 UTC 偏移量字符串
 * @returns 如 "+08:00" 或 "-05:00"
 */
function getUtcOffset(date: Date, tz?: string): string {
    try {
        // 利用 Intl 格式化 UTC 和目标时区，算差值
        const utcParts = new Intl.DateTimeFormat("en-US", {
            timeZone: "UTC",
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit",
            hour12: false,
        }).formatToParts(date);
        const localParts = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit",
            hour12: false,
        }).formatToParts(date);

        const toMinutes = (p: Intl.DateTimeFormatPart[]) => {
            const get = (type: string) => parseInt(p.find(x => x.type === type)?.value ?? "0", 10);
            return get("day") * 1440 + get("hour") * 60 + get("minute");
        };

        let diffMin = toMinutes(localParts) - toMinutes(utcParts);
        // 处理跨日
        if (diffMin > 720) diffMin -= 1440;
        if (diffMin < -720) diffMin += 1440;

        const sign = diffMin >= 0 ? "+" : "-";
        const absDiff = Math.abs(diffMin);
        const h = String(Math.floor(absDiff / 60)).padStart(2, "0");
        const m = String(absDiff % 60).padStart(2, "0");
        return `${sign}${h}:${m}`;
    } catch {
        return "+00:00";
    }
}
