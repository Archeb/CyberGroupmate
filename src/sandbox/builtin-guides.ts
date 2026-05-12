/**
 * builtin-guides.ts — 内置能力指南注册表
 *
 * 这些指南属于框架/内置模块，不来自 workspace/skills。
 * 它们用于 progressive disclosure：Pass 1 只暴露 useXxx() 入口，
 * Pass 2 按需注入完整指南。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MethodDoc, ModuleEntry } from "./modules/module-registry.js";

interface BuiltinGuideSpec {
    moduleName: string;
    methodName: string;
    file: string;
    description: string;
    brief: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BUILTIN_GUIDES: BuiltinGuideSpec[] = [
    {
        moduleName: "onebot",
        methodName: "useMessages",
        file: "onebot/useMessages.md",
        description: "QQ / OneBot 平台 API",
        brief: "加载 OneBot/NapCat 消息指南。用于消息检索、历史消息、已读、转发、合并转发和消息表情点赞等成组能力；本方法只披露指南。",
    },
    {
        moduleName: "onebot",
        methodName: "useGroupAdministration",
        file: "onebot/useGroupAdministration.md",
        description: "QQ / OneBot 平台 API",
        brief: "加载 OneBot/NapCat 群管理指南。用于群资料、成员列表、禁言、踢人、管理员、公告、精华消息和群待办等成组能力；本方法只披露指南。",
    },
    {
        moduleName: "onebot",
        methodName: "useFiles",
        file: "onebot/useFiles.md",
        description: "QQ / OneBot 平台 API",
        brief: "加载 OneBot/NapCat 文件指南。用于图片/语音/文件解析、群文件系统、文件 URL 和跨机器媒体处理注意事项；本方法只披露指南。",
    },
    {
        moduleName: "onebot",
        methodName: "useUsersAndProfile",
        file: "onebot/useUsersAndProfile.md",
        description: "QQ / OneBot 平台 API",
        brief: "加载 OneBot/NapCat 用户与资料指南。用于好友列表、陌生人资料、最近会话、点赞、好友请求和账号资料等成组能力；本方法只披露指南。",
    },
    {
        moduleName: "onebot",
        methodName: "useSystemUtilities",
        file: "onebot/useSystemUtilities.md",
        description: "QQ / OneBot 平台 API",
        brief: "加载 OneBot/NapCat 工具指南。用于版本/状态探测、发送能力检查、OCR、URL 安全检查、频道资料和 AI 语音等低频能力；本方法只披露指南。",
    },
    {
        moduleName: "telegram",
        methodName: "useInlineBot",
        file: "telegram/useInlineBot.md",
        description: "Telegram 平台 API",
        brief: "加载 inline bot 使用指南。用于像 Telegram 客户端输入 @bot query 一样查询 inline bot 并发送某个结果；本方法只披露指南，不执行实际发送。",
    },
    {
        moduleName: "telegram",
        methodName: "useStories",
        file: "telegram/useStories.md",
        description: "Telegram 平台 API",
        brief: "加载 Stories 使用指南。用于读取、发布、编辑、删除、置顶 Story，以及查看互动和观看者；本方法只披露指南，不执行实际 Story 操作。",
    },
    {
        moduleName: "telegram",
        methodName: "usePolls",
        file: "telegram/usePolls.md",
        description: "Telegram 平台 API",
        brief: "加载投票流程指南。用于创建投票/测验、读取投票结果等成组流程；本方法只披露相关 API，不会发起投票。",
    },
    {
        moduleName: "telegram",
        methodName: "usePeerResolution",
        file: "telegram/usePeerResolution.md",
        description: "Telegram 平台 API",
        brief: "加载 peer 解析指南。用于处理 PEER_ID_INVALID、access hash 缺失、裸数字 user id 无法发送等问题；本方法只披露排障流程。",
    },
    {
        moduleName: "telegram",
        methodName: "useMessageSearch",
        file: "telegram/useMessageSearch.md",
        description: "Telegram 平台 API",
        brief: "加载历史消息检索指南。用于主动爬楼、搜索视野外上下文或流式遍历历史；本方法只披露检索 API 和使用流程。",
    },
    {
        moduleName: "telegram",
        methodName: "useAccountProfile",
        file: "telegram/useAccountProfile.md",
        description: "Telegram 平台 API",
        brief: "加载账号资料指南。用于修改 bio、姓名、用户名、头像、生日、emoji status、close friends 等个人资料；本方法只披露指南，不直接修改账号。",
    },
    {
        moduleName: "telegram",
        methodName: "useAdvancedMessages",
        file: "telegram/useAdvancedMessages.md",
        description: "Telegram 平台 API",
        brief: "加载高级消息指南。用于复制、评论、引用、定时消息、网页预览、reaction 用户和消息关联查询等成组能力；本方法只披露指南。",
    },
    {
        moduleName: "telegram",
        methodName: "useChatAdministration",
        file: "telegram/useChatAdministration.md",
        description: "Telegram 平台 API",
        brief: "加载群组/频道管理指南。用于建群建频道、成员权限、管理员、标题描述头像、慢速模式和内容保护等管理操作；本方法只披露指南。",
    },
    {
        moduleName: "telegram",
        methodName: "useInvites",
        file: "telegram/useInvites.md",
        description: "Telegram 平台 API",
        brief: "加载邀请链接与入群请求指南。用于创建/编辑/撤销邀请链接、查看邀请成员、处理 join request 或预览邀请链接；本方法只披露指南。",
    },
    {
        moduleName: "telegram",
        methodName: "useForumTopics",
        file: "telegram/useForumTopics.md",
        description: "Telegram 平台 API",
        brief: "加载论坛话题指南。用于确认群是否开启 Forum、列出话题或定位 topic id；本方法只披露相关 API。",
    },
];

function guidePath(spec: BuiltinGuideSpec): string {
    return join(__dirname, "builtin-guides", spec.file);
}

function readGuideBody(spec: BuiltinGuideSpec): string {
    return readFileSync(guidePath(spec), "utf-8").trim();
}

function formatGuide(spec: BuiltinGuideSpec): string {
    const body = readGuideBody(spec);
    return [
        `# ${spec.moduleName}.${spec.methodName}`,
        "",
        body,
    ].join("\n");
}

export function loadBuiltinGuideContent(moduleName: string, methodName: string): string | null {
    const spec = BUILTIN_GUIDES.find(item => item.moduleName === moduleName && item.methodName === methodName);
    if (!spec) return null;
    return formatGuide(spec);
}

export function loadBuiltinGuideRegistry(): ModuleEntry[] {
    const byModule = new Map<string, ModuleEntry>();

    for (const spec of BUILTIN_GUIDES) {
        const method: MethodDoc = {
            name: spec.methodName,
            brief: spec.brief,
            fullDoc: formatGuide(spec),
            includeTypeDefs: false,
        };

        const existing = byModule.get(spec.moduleName);
        if (existing) {
            existing.methods.push(method);
        } else {
            byModule.set(spec.moduleName, {
                name: spec.moduleName,
                description: spec.description,
                methods: [method],
            });
        }
    }

    return [...byModule.values()];
}
