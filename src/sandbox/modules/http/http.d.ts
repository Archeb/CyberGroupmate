/**
 * shared/http.d.ts — HTTP Webhook 模块类型定义
 *
 * 注册 HTTP webhook 端点，外部系统通过 HTTP POST 触发 sandbox 代码执行。
 * Webhook 持久化到磁盘，Worker 重启后自动恢复。
 */

declare const http: {
    /**
     * 注册 webhook 端点。
     * 外部可通过 POST /webhook/{path} 触发 handler 代码执行。
     * handler 代码中可通过 `request` 变量访问请求数据。
     *
     * @param path - Webhook 路径（唯一标识，不含前缀斜杠）
     * @param handlerCode - 收到请求时执行的 JavaScript 代码字符串
     * @returns webhook ID
     *
     * @example
     * // 注册一个接收 GitHub Push 事件的 webhook
     * const id = await http.onWebhook("github-push", `
     *   const payload = JSON.parse(request.body);
     *   const repo = payload.repository?.full_name ?? "unknown";
     *   await telegram.sendText(chatId, "📦 Push to " + repo + ": " + payload.head_commit?.message);
     * `);
     * console.log("Webhook 已注册:", id);
     * console.log("URL: /webhook/github-push");
     */
    onWebhook(path: string, handlerCode: string): Promise<string>;

    /**
     * 移除 webhook
     * @param webhookId - webhook ID（由 onWebhook 返回）
     *
     * @example
     * await http.removeWebhook("some-webhook-id");
     */
    removeWebhook(webhookId: string): Promise<void>;

    /**
     * 列出当前所有 webhook
     *
     * @example
     * const hooks = await http.listWebhooks();
     * for (const h of hooks) {
     *   console.log(`${h.id}: POST /webhook/${h.path}`);
     * }
     */
    listWebhooks(): Promise<Array<{ id: string; path: string }>>;
};
