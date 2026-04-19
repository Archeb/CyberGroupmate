/**
 * shell.d.ts — 终端 Tab 管理模块
 *
 * 提供类似 tmux/terminal tabs 的多终端管理能力。
 * 主终端 "default" 是所有 ```bash``` 代码块的执行目标。
 * 当主终端被长时间运行的服务阻塞时，可以将其 detach 到后台并获得全新主终端。
 */

declare const shell: {
    /**
     * 列出所有存活的终端 Tab 及其状态。
     *
     * @returns 每个 tab 的 id、状态和最近输出预览
     *
     * @example
     * const tabs = await shell.listTabs();
     * // [{ id: "default", state: "idle", recentOutput: "..." },
     * //  { id: "web-server", state: "busy", recentOutput: "Listening on :3000" }]
     */
    listTabs(): Promise<Array<{
        id: string;
        state: "idle" | "busy";
        recentOutput: string;
    }>>;

    /**
     * 分离当前主终端到后台，并立刻获得一个全新的 default 终端。
     *
     * 当主终端被长时间运行的命令（如 `npm run dev`）阻塞时：
     * 1. 当前 default 终端被重命名为 newTabId 并移入后台
     * 2. 系统自动创建全新的 default 终端
     * 3. 后续 ```bash``` 代码块将在新终端中执行
     *
     * @param newTabId 后台标签名（如 "web-server"、"db"）
     *
     * @example
     * // 启动 dev server（会超时，但进程仍在运行）
     * // ```bash
     * // npm run dev
     * // ```
     * // 收到 [⚠ Command timed out]
     *
     * // 将被阻塞的终端移到后台，释放主通道
     * await shell.detach("dev-server");
     *
     * // 现在可以继续在新的 default 终端工作
     */
    detach(newTabId: string): Promise<void>;

    /**
     * 读取指定终端的输出历史。
     *
     * 用于排查超时命令的残留输出，或查看后台服务日志。
     * 默认读取 default 终端，可指定 tabId 读取后台终端。
     *
     * @param tabId 终端标签 ID（默认 "default"）
     * @param lines 返回最近 N 行（默认 50）
     *
     * @example
     * // 查看 dev-server 的运行日志
     * const logs = await shell.read("dev-server", 20);
     * console.log(logs);
     */
    read(tabId?: string, lines?: number): Promise<string>;

    /**
     * 向指定终端注入按键输入。
     *
     * 用于应对交互式 CLI 的确认提示（如 "Is this ok? (y/N)"）。
     * 也可发送 Ctrl+C（"\x03"）来优雅地中断进程。
     *
     * @param input 要发送的文本（如 "y\n"、"\x03"）
     * @param tabId 目标终端（默认 "default"）
     *
     * @example
     * // 对交互提示输入 y
     * await shell.sendInput("y\n");
     *
     * @example
     * // 向后台服务发送 Ctrl+C 停止它
     * await shell.sendInput("\x03", "dev-server");
     */
    sendInput(input: string, tabId?: string): Promise<void>;

    /**
     * 销毁指定终端中的所有进程并回收该 tab。
     * 如果销毁的是 default 终端，会自动创建新的 default。
     *
     * @param tabId 要销毁的终端（默认 "default"）
     *
     * @example
     * // 强制结束并回收一个后台终端
     * await shell.kill("dev-server");
     *
     * // 重置卡死的主终端
     * await shell.kill();
     */
    kill(tabId?: string): Promise<void>;

    /**
     * 获取当前主终端的工作目录。
     */
    cwd(): Promise<string>;
};
