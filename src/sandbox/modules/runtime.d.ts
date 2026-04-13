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

    /**
     * 启动持久化后台任务（Worker 重启后自动恢复）。
     * 代码以字符串形式存储，触发时在 sandbox 中执行。
     * 代码中可通过 `signal` 变量访问 AbortSignal。
     *
     * @param name - 任务名称（唯一标识，同名会替换）
     * @param code - JavaScript 代码字符串
     *
     * @example
     * runtime.spawnPersistent("monitor", `
     *   while (!signal.aborted) {
     *     console.log("heartbeat at " + new Date().toISOString());
     *     await new Promise(r => setTimeout(r, 60000));
     *   }
     * `);
     */
    spawnPersistent(name: string, code: string): void;

    /** 停止一个后台任务（同时清除持久化记录） */
    kill(name: string): void;

    /** 列出后台任务 */
    ps(): string[];

    /** 返回当前 sandbox 的 home 目录路径（per-chat 隔离） */
    home(): string;

    /** 返回 workspace 根目录路径 */
    workspace(): string;
};
