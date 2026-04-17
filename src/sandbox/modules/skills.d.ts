/**
 * shared/skills.d.ts — Skills 高层能力 + 管理接口
 */

declare const skills: {
    memory: {
        /** 检索记忆并针对查询生成结构化总结 */
        recallAndSummarize(query: string, options?: Record<string, unknown>): Promise<unknown>;
        /** 主动搜索多渠道历史档案以详细回答复杂问题 */
        browseForAnswer(request: Record<string, unknown>): Promise<unknown>;
    };

    /**
     * 列出当前已加载的 Skills 名称
     * @returns 如 ["tavily", "weather", "yt-dlp"]
     */
    list(): string[];

    /**
     * 热重载所有 Skills。在 workspace/skills/ 下创建/修改文件后调用。
     * @returns 重载后的 Skills 名称列表
     * 
     * @example
     * // 创建 Skill 后重载
     * fs.writeFile("skills/myapi/index.ts", code);
     * fs.writeFile("skills/myapi/myapi.d.ts", typeDefs);
     * const loaded = await skills.reload();
     * console.log("已加载:", loaded);
     */
    reload(): Promise<string[]>;

    /**
     * 安装 npm 包到 workspace/skills/ 目录
     * @param packages 包名列表，如 ["axios", "cheerio@1.0.0"]
     * @returns 安装输出
     * 
     * @example
     * await skills.npmInstall(["cheerio", "node-fetch"]);
     */
    npmInstall(packages: string[]): Promise<string>;
};
