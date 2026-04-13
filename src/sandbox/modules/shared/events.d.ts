/**
 * shared/events.d.ts — 事件监听器模块类型定义
 *
 * 注册事件监听器，当匹配的事件到达时在 sandbox 中执行处理代码。
 * 监听器持久化到磁盘，Worker 重启后自动恢复。
 */

declare const events: {
    /**
     * 注册事件监听器。匹配 type 前缀的事件会触发 handlerCode 在 sandbox 中执行。
     * handler 代码中可通过 `event` 变量访问事件数据。
     *
     * @param typePrefix - 事件类型前缀（如 "telegram.message" 匹配所有以此开头的事件）
     * @param handlerCode - 触发时执行的 JavaScript 代码字符串
     * @returns 监听器 ID
     *
     * @example
     * // 监听新消息事件
     * const id = events.on("telegram.message", `
     *   if (event.text?.includes("ping")) {
     *     runtime.notify({ type: "system.pong", from: event.chatId });
     *   }
     * `);
     * console.log("监听器已注册:", id);
     *
     * @example
     * // 监听所有系统事件
     * events.on("system.", `
     *   console.log("系统事件:", event.type);
     * `);
     */
    on(typePrefix: string, handlerCode: string): string;

    /**
     * 移除监听器
     * @param listenerId - 监听器 ID（由 on 返回）
     *
     * @example
     * events.off("some-listener-id");
     */
    off(listenerId: string): void;

    /**
     * 列出当前所有监听器
     *
     * @example
     * const listeners = events.list();
     * for (const l of listeners) {
     *   console.log(`${l.id}: 监听 "${l.typePrefix}"`);
     * }
     */
    list(): Array<{
        id: string;
        typePrefix: string;
    }>;
};
