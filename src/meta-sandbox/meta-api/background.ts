import type { HarnessManager } from "../../harness/manager.js";
import type { HarnessNotify } from "../../harness/types.js";

type BackgroundEnqueueOptions = Omit<HarnessNotify, "content" | "source">;

export function createBackgroundApi(getHarnessManager: () => HarnessManager | null) {
    return {
        enqueue: async (content: string, source?: string, options?: BackgroundEnqueueOptions) => {
            // sandbox 里是 LLM 运行时生成的 JS，静态类型管不住；对象式调用会让对象落进 content 位，
            // 渲染成 "[object Object]"。这里报错回喂给 agent（runner 会自动注入本文档）让它自我修正。
            if (typeof content !== "string") {
                throw new TypeError(
                    `background.enqueue(content, source?, options?) 的 content 必须是 string，收到的是 ` +
                    `${content === null ? "null" : typeof content}。` +
                    `对象式调用会被拒绝：请改写为 background.enqueue(obj.content, obj.source, obj.options)，` +
                    `或直接 background.enqueue("任务描述")。`,
                );
            }
            const hm = getHarnessManager();
            if (!hm) return { queued: false, reason: "Background Agent not configured" };
            hm.enqueue({ content, source: source ?? "meta", ...(options ?? {}) });
            return { queued: true, queueLength: hm.queueLength };
        },
        getStatus: async () => {
            const hm = getHarnessManager();
            if (!hm) return { enabled: false };
            return { enabled: true, ...hm.getStatus() };
        },
    };
}
