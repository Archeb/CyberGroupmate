/**
 * shared/skills.d.ts — Skills 高层能力 + 管理接口
 */

declare const skills: {
    /**
     * 安装或创建一个新 Skill。支持SKILL.md 型（多数场景）和TS Skills（复杂能力场景）
     * 两种方式完成文件后，都需要调用 skills.reload() 生效。
     * @param name 拟创建的 Skill 名称
     * @returns 按规范创建 skill 的操作说明文档
     */
    install(name: string): string;

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
