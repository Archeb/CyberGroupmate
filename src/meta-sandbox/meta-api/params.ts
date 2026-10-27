/**
 * meta-api 必填参数校验。
 *
 * 抛出带自解释信息的 Error 而非返回错误对象：错误会沿 execute() 的 error 路径变成
 * observation，并触发 two-pass API 文档注入，让 agent 在下一轮自我修正。
 */

export function requireNonEmptyString(value: unknown, name: string, hint?: string): string {
    if (typeof value === "string" && value.trim()) {
        return value;
    }
    const got = value === undefined
        ? "undefined"
        : value === null
            ? "null"
            : typeof value === "string"
                ? "空字符串"
                : `${typeof value}`;
    throw new Error(`${name} is required (got ${got})${hint ? ` — ${hint}` : ""}`);
}
