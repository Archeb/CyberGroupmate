/**
 * modules/skills.ts — Skills 模块
 *
 * 高层代码型 skills 能力：
 * - skills.memory: recallAndSummarize, browseForAnswer
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
        memory: {
            recallAndSummarize: async (query: string, options?: Record<string, unknown>) =>
                env.callHost("memory.recall", [query, options]),
            browseForAnswer: async (request: Record<string, unknown>) =>
                env.callHost("memory.browseHistory", [request]),
        },
        /** 列出当前已加载的 Skills */
        list: () => _managerCallbacks.listSkills(),
        /** 热重载所有 Skills（创建/修改 Skill 文件后调用） */
        reload: () => _managerCallbacks.reloadSkills(),
        /** 安装 npm 包到 workspace/skills/（如 skills.npmInstall(["axios", "cheerio"])） */
        npmInstall: (packages: string[]) => _managerCallbacks.npmInstall(packages),
    };
}
