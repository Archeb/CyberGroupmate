/**
 * promise-tracker.ts — 追踪注入给 Agent 的 API 返回的所有 Promise
 *
 * 在运行时拦截所有注入 API 的函数调用，收集返回的 Promise。
 * 代码执行结束后调用 flush() 等待所有未被 await 的 Promise 完成，
 * 从根本上解决 LLM 生成代码遗漏 await 导致的空输出 / 重复发送问题。
 */

export interface PromiseTracker {
    /** 深度包装对象，拦截所有函数调用并追踪返回的 Promise */
    wrap<T extends Record<string, unknown>>(obj: T): T;
    /** 等待所有未 settle 的 Promise 完成，返回是否有遗漏的异步调用 */
    flush(): Promise<{ count: number; warning: string | null }>;
}

export function createPromiseTracker(): PromiseTracker {
    const pending: Promise<unknown>[] = [];
    const wrapped = new WeakMap<object, unknown>();

    function wrap<T extends Record<string, unknown>>(obj: T): T {
        if (typeof obj !== "object" || obj === null) return obj;

        // 避免对同一个对象重复包装
        if (wrapped.has(obj)) return wrapped.get(obj) as T;

        const proxy = new Proxy(obj, {
            get(target, prop, receiver) {
                const val = Reflect.get(target, prop, receiver);
                if (typeof val === "function") {
                    return function (this: unknown, ...args: unknown[]) {
                        const result = val.apply(target, args);
                        if (result instanceof Promise) {
                            // 吞掉错误防止 unhandled rejection（原始调用者仍能 catch）
                            pending.push(result.catch(() => {}));
                        }
                        return result;
                    };
                }
                // 递归包装嵌套对象（如 skills.social.replyInTelegram）
                if (typeof val === "object" && val !== null) {
                    return wrap(val as Record<string, unknown>);
                }
                return val;
            },
        }) as T;

        wrapped.set(obj, proxy);
        return proxy;
    }

    async function flush(): Promise<{ count: number; warning: string | null }> {
        let total = 0;
        // 循环：Promise resolve 后可能又产生新的未 await 的调用
        while (pending.length > 0) {
            const batch = pending.splice(0);
            total += batch.length;
            await Promise.allSettled(batch);
        }
        return {
            count: total,
            warning: total > 0
                ? "[System] 检测到未 await 的异步 API 调用，系统已自动等待执行完毕。下次请对所有异步操作使用 await。"
                : null,
        };
    }

    return { wrap, flush };
}
