/**
 * modules/skills.ts — Skills 模块
 *
 * 高层代码型 skills 能力：
 * 
 * 管理能力：
 * - skills.list(): 列出已加载的 Skills
 * - skills.reload(): 热重载所有 Skills
 * - skills.npmInstall(packages): 安装 npm 依赖
 */

import type { CapabilityRegistryEnv } from "../../capability-registry.js";
import { createTelegramClientProxy } from "../telegram/index.js";

/** 供外部注入的 Skill 管理回调 */
export interface SkillManagerCallbacks {
    /** 返回当前已加载的 skill 名称列表 */
    listSkills: () => string[];
    /** 热重载所有 Skills，返回新的 skill 名称列表 */
    reloadSkills: () => Promise<string[]>;
    /** 运行时安装 npm 包 */
    npmInstall: (packages: string[]) => Promise<string>;
}

/** 默认的 no-op 回调（启动前未注入时使用） */
let _managerCallbacks: SkillManagerCallbacks = {
    listSkills: () => [],
    reloadSkills: async () => [],
    npmInstall: async () => "not available",
};

/** 注入管理回调（由 sandbox-worker 调用） */
export function setSkillManagerCallbacks(callbacks: SkillManagerCallbacks): void {
    _managerCallbacks = callbacks;
}

export function installSkills(
    env: CapabilityRegistryEnv,
    sentHistory: Map<string, Set<string>>,
    deduplicateSentMessages = true,
) {
    const tg = createTelegramClientProxy(env, sentHistory, deduplicateSentMessages);
    return {
        /** 获取安装/创建新 Skill 的步骤说明（无实际代码动作） */
        install: (name: string) => {
            return `【创建/安装 Skill: ${name} 的操作指南】
系统支持两种 Skill 形态，请按场景选择：

1. SKILL.md 型（推荐多数场景）
    - 规范：遵循 https://agentskills.io/specification
    - 文件：创建 \`workspace/skills/${name}/SKILL.md\`
    - 适用：流程化任务、文档驱动能力、模板化执行

2. TS Skills（复杂能力场景）
    - 实现文件：创建 \`workspace/skills/${name}/index.ts\`
    - 类型声明：创建 \`workspace/skills/${name}/${name}.d.ts\`
    - 要求：\`index.ts\` 提供 default export 或同名导出；\`.d.ts\` 用 TypeScript 接口 + TSDoc 清晰描述能力
    - 依赖：如需第三方包，先调用 \`skills.npmInstall(['包名'])\`
    - 建议：先参考现有 TS Skill 示例，确保类型定义清晰、示例代码合理、接口设计简洁
    - 适用：复杂逻辑、需要引入外部 npm 包、希望直接复用 npm 生态

3. 使其生效
    - 文件创建或修改后，调用 \`skills.reload()\` 热重载
    - 重载成功后，可按全局变量 \`${name}\` 直接调用该 Skill。`;
        },
        /** 列出当前已加载的 Skills */
        list: () => _managerCallbacks.listSkills(),
        /** 热重载所有 Skills（创建/修改 Skill 文件后调用） */
        reload: () => _managerCallbacks.reloadSkills(),
        /** 安装 npm 包到 workspace/skills/（如 skills.npmInstall(["axios", "cheerio"])） */
        npmInstall: (packages: string[]) => _managerCallbacks.npmInstall(packages),
    };
}
