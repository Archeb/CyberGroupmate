/**
 * shared/kv.d.ts — 持久化键值存储模块类型定义
 *
 * 简单的 per-chat 键值存储，数据持久化到 SQLite。
 * 比 ctx 更正式的存储方式，支持 TTL 过期。
 */

declare const kv: {
    /**
     * 读取键值
     * @param key - 键名
     * @returns 值字符串，不存在时返回 null
     *
     * @example
     * const token = await kv.get("api_token");
     * if (token) {
     *   console.log("已有 token");
     * }
     */
    get(key: string): Promise<string | null>;

    /**
     * 写入键值
     * @param key - 键名
     * @param value - 值（字符串）
     * @param ttlSeconds - 可选的过期时间（秒）。不设置则永不过期。
     *
     * @example
     * await kv.set("last_check", new Date().toISOString());
     *
     * @example
     * // 设置 1 小时后过期的缓存
     * await kv.set("weather_cache", JSON.stringify(data), 3600);
     */
    set(key: string, value: string, ttlSeconds?: number): Promise<void>;

    /**
     * 删除键
     * @param key - 键名
     *
     * @example
     * await kv.del("temp_data");
     */
    del(key: string): Promise<void>;

    /**
     * 列出键名（可按前缀过滤）
     * @param prefix - 可选的键名前缀
     * @returns 匹配的键名列表
     *
     * @example
     * const keys = await kv.keys("cache_");
     * console.log("缓存键:", keys);
     */
    keys(prefix?: string): Promise<string[]>;
};
