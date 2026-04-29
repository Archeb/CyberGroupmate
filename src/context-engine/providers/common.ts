/**
 * context-engine/providers/common.ts — 通用 SectionProviders
 *
 * 提供可复用的 provider 工厂函数，用于：
 * - 静态模板文本（从 .md 文件加载，支持简单变量替换）
 * - 固定字符串内容
 */

import type { SectionProvider, SectionSchema } from "../types.js";

/**
 * 创建一个静态文本 provider。
 * 内容在 resolve 时确定，不做 diff。
 */
export function createStaticProvider(
    schema: Omit<SectionSchema, "cache"> & { cache?: SectionSchema["cache"] },
    content: string,
): SectionProvider<string> {
    return {
        schema: { ...schema, cache: schema.cache ?? "static" } as SectionSchema,
        resolve() { return content || null; },
        render(data) { return data; },
        hash(data) { return `${data.length}:${data.slice(0, 80)}`; },
    };
}

/**
 * 创建一个动态文本 provider。
 * 每次 resolve 时从 ctx 中读取指定 key 的字符串值。
 */
export function createDynamicTextProvider(
    schema: SectionSchema,
    ctxKey: string,
): SectionProvider<string> {
    return {
        schema,
        resolve(ctx) {
            const val = ctx[ctxKey];
            if (val == null || val === "") return null;
            return String(val);
        },
        render(data) { return data; },
        hash(data) { return `${data.length}:${data.slice(0, 80)}`; },
    };
}

/**
 * 创建一个从 ResolveContext 中按 key 取值的 snapshot provider。
 * 适用于每次需要完整发送但不做 diff 的数据。
 *
 * @param schema - section 元数据
 * @param ctxKey - ResolveContext 中的 key
 * @param renderFn - 将数据渲染为文本的函数
 */
export function createSnapshotProvider<T>(
    schema: SectionSchema,
    ctxKey: string,
    renderFn: (data: T) => string,
): SectionProvider<T> {
    return {
        schema,
        resolve(ctx) {
            const val = ctx[ctxKey] as T | null | undefined;
            return val ?? null;
        },
        render: renderFn,
    };
}
