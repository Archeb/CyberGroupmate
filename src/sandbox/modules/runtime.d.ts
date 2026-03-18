/**
 * shared/runtime.d.ts — 所有 scene 共享的 runtime 能力
 */

declare const runtime: {
    /** 推送事件到通知中心 */
    notify(event: { type: string; [key: string]: unknown }): void;

    /** 请求用户输入 */
    input(prompt: string): Promise<string>;

    /** 直接打印到宿主 */
    print(msg: string): void;

    /** 启动一个命名后台任务 */
    spawn(name: string, fn: (signal: AbortSignal) => Promise<void>): void;

    /** 停止一个后台任务 */
    kill(name: string): void;

    /** 列出后台任务 */
    ps(): string[];
};
