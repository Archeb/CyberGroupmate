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

import type { CapabilityRegistryEnv } from "../capability-registry.js";
import { createTelegramClientProxy } from "./telegram.js";

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

export function installSkills(env: CapabilityRegistryEnv, sentHistory: Map<string, Set<string>>) {
    const tg = createTelegramClientProxy(env, sentHistory);
    return {
        /** 获取安装/创建新 Skill 的步骤说明（无实际代码动作） */
        install: (name: string) => {
            return `【创建/安装 Skill: ${name} 的操作指南】
系统需要你通过文件操作工具自行创建所需的文件，请严格遵循以下目录结构和规范：

1. 核心实现文件：
   创建 \`workspace/skills/${name}/index.ts\`
   要求：必须提供默认导出 (default export) 或者与模块同名的导出 (export const ${name} = ...)。

2. 类型声明与文档（必须）：
   创建 \`workspace/skills/${name}/${name}.d.ts\`
   要求：系统依据此文件解析能力接口，将其呈现为工具函数。请用标准的 TypeScript 接口格式和 TSDoc 注释写明每个方法的用处。

3. npm 依赖包：
   需要依赖的话，请在写代码前调用全局方法 \`skills.npmInstall(['包名'])\` 以聚合依赖到 skills 目录。

4. 使其生效：
   全部文件保存后，必须调用 \`skills.reload()\` 触发热重载，之后即可以全局变量 \`${name}\` 的形式直接调用。`;
        },
        /** 列出当前已加载的 Skills */
        list: () => _managerCallbacks.listSkills(),
        /** 热重载所有 Skills（创建/修改 Skill 文件后调用） */
        reload: () => _managerCallbacks.reloadSkills(),
        /** 安装 npm 包到 workspace/skills/（如 skills.npmInstall(["axios", "cheerio"])） */
        npmInstall: (packages: string[]) => _managerCallbacks.npmInstall(packages),
    };
}
