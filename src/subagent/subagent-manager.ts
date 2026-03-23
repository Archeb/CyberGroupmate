/**
 * subagent-manager.ts — Subagent 实例管理器
 *
 * 管理所有群组的 GroupSubagent 实例生命周期：
 * - 按需创建（getOrCreate）
 * - 持久保留（chat-bound，不做空闲回收）
 * - 启动时恢复（restoreAll）
 * - 获取全部实例列表
 *
 * Subagent 实例绑定到 chat，通过 compaction 和 context quota 管理内存。
 * Sandbox 空闲回收由 SandboxPool 独立管理。
 *
 * 参考设计：subagent.md §2
 */

import { GroupSubagent, type GroupSubagentOptions, type RecordingPipelineDeps } from "./group-subagent.js";
import { CodeActExecutor } from "./code-act-executor.js";
import type { SubagentConfig, GroupStickiness, StickinessLevel } from "./types.js";
import { DEFAULT_SUBAGENT_CONFIG } from "./types.js";
import { createLogger } from "../core/logger.js";
import { existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { chatIdToFileName, fileNameToChatId, getPlatform, type PlatformName } from "../core/chat-id.js";
import type { MemoryStoreV2 } from "../memory-v2/index.js";

const log = createLogger("subagent-manager");

/** SubagentManager 配置 */
export interface SubagentManagerConfig {
    /** Observer 配置 */
    observerConfig?: ConstructorParameters<typeof GroupSubagent>[0]["observerConfig"];
    /** 默认 stickiness 工厂（可注入 MemoryV2 lookup） */
    stickinessProvider?: (chatId: string) => GroupStickiness | undefined;
    /** RecordingPipeline 依赖（注入每个 GroupSubagent） */
    recordingDeps?: RecordingPipelineDeps;
    /** MemoryV2 实例（用于启动恢复话题） */
    memory?: MemoryStoreV2;
    /** Session 持久化根目录（默认 workspace/sessions） */
    sessionsDir?: string;

}

const DEFAULT_MANAGER_CONFIG: SubagentManagerConfig = {};

/**
 * SubagentManager — 群组 Subagent 实例管理器
 *
 * Subagent 实例是 chat-bound 的，不会被空闲回收。
 * 通过 restoreAll() 在启动时从磁盘恢复已有 session。
 */
export class SubagentManager {
    private subagents = new Map<string, GroupSubagent>();
    private config: SubagentManagerConfig;

    constructor(config?: Partial<SubagentManagerConfig>) {
        this.config = { ...DEFAULT_MANAGER_CONFIG, ...config };
    }

    /**
     * 获取指定 chatId 的 session 文件路径
     */
    getSessionFilePath(chatId: string): string {
        const sessionsDir = this.config.sessionsDir ?? "workspace/sessions";
        const platform = getPlatform(chatId);
        const fileName = chatIdToFileName(chatId);
        return join(sessionsDir, platform, `${fileName}.json`);
    }

    /**
     * 获取或创建指定 chatId 的 GroupSubagent
     */
    getOrCreate(chatId: string): GroupSubagent {
        let subagent = this.subagents.get(chatId);

        if (!subagent) {
            const stickiness = this.config.stickinessProvider?.(chatId);
            subagent = new GroupSubagent({
                chatId,
                observerConfig: this.config.observerConfig,
                stickiness,
                recordingDeps: this.config.recordingDeps,
            });
            this.subagents.set(chatId, subagent);
            log.info("getOrCreate: 创建新 Subagent", { chatId, total: this.subagents.size });
        }

        subagent.touch();
        return subagent;
    }

    /**
     * 获取指定 chatId 的 GroupSubagent（不创建）
     */
    get(chatId: string): GroupSubagent | undefined {
        return this.subagents.get(chatId);
    }

    /**
     * 获取所有 Subagent 实例
     */
    getAllSubagents(): GroupSubagent[] {
        return Array.from(this.subagents.values());
    }

    /**
     * 获取所有 chatId
     */
    getChatIds(): string[] {
        return Array.from(this.subagents.keys());
    }

    /**
     * 从磁盘恢复所有已保存的 session
     *
     * 扫描 {sessionsDir}/{platformName}/ 目录下的 *.json 文件，
     * 为每个 chatId 创建 GroupSubagent + CodeActExecutor，恢复 session 状态。
     *
     * @returns 恢复的 chatId 列表
     */
    restoreAll(): string[] {
        const sessionsDir = this.config.sessionsDir ?? "workspace/sessions";

        if (!existsSync(sessionsDir)) {
            log.info("restoreAll: sessions 根目录不存在，跳过", { sessionsDir });
            return [];
        }

        const restored: string[] = [];

        // 扫描所有平台子目录（如 telegram/, discord/），而非硬编码单个平台
        let platformDirs: string[];
        try {
            platformDirs = readdirSync(sessionsDir, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name);
        } catch (err) {
            log.error("restoreAll: 扫描 sessions 根目录失败", { sessionsDir, error: String(err) });
            return [];
        }

        for (const platformDir of platformDirs) {
            const dir = join(sessionsDir, platformDir);

            try {
                const files = readdirSync(dir).filter(f => f.endsWith(".json"));

                for (const file of files) {
                    const rawName = basename(file, ".json");
                    // 支持旧格式（裸 chatId）和新格式（composite key 文件名）
                    let chatId: string;
                    try {
                        chatId = fileNameToChatId(rawName);
                    } catch {
                        // 旧格式文件名（无平台前缀），用目录名作为平台
                        chatId = `${platformDir}:${rawName}`;
                    }
                    const filePath = join(dir, file);

                    try {
                        // 创建 SubagentManager 实例（如果不存在）
                        const subagent = this.getOrCreate(chatId);

                        // 创建 CodeActExecutor 并恢复 session
                        if (!subagent.codeActExecutor) {
                            const executor = new CodeActExecutor(chatId);
                            const loaded = executor.loadSession(filePath);

                            if (loaded) {
                                subagent.codeActExecutor = executor;
                                subagent.restoreLastAgentReplyAt();

                                // 从 MemoryV2 恢复最近话题到 TopicRegistry
                                if (this.config.memory) {
                                    const topicCount = subagent.loadRecentTopics(this.config.memory);
                                    log.info("restoreAll: 恢复话题", { chatId, topicCount });
                                }

                                restored.push(chatId);
                                log.info("restoreAll: 恢复 session", {
                                    chatId,
                                    sessionSize: executor.getSessionSize(),
                                    executionCount: executor.getExecutionCount(),
                                    registrySize: subagent.topicRegistry.size,
                                });
                            }
                        }
                    } catch (err) {
                        log.warn("restoreAll: 恢复单个 session 失败", {
                            chatId,
                            file,
                            error: String(err),
                        });
                    }
                }
            } catch (err) {
                log.error("restoreAll: 扫描平台目录失败", { dir, error: String(err) });
            }
        }

        log.info("restoreAll: 完成", {
            restored: restored.length,
            total: this.subagents.size,
        });

        return restored;
    }

    /**
     * 手动移除指定 chatId 的 Subagent
     */
    remove(chatId: string): boolean {
        const sub = this.subagents.get(chatId);
        if (sub) {
            sub.dispose();
            this.subagents.delete(chatId);
            log.info("remove: 移除 Subagent", { chatId, remaining: this.subagents.size });
            return true;
        }
        return false;
    }

    /**
     * 当前实例数
     */
    get size(): number {
        return this.subagents.size;
    }

    /**
     * 释放所有实例
     */
    dispose(): void {
        for (const sub of this.subagents.values()) {
            sub.dispose();
        }
        this.subagents.clear();
        log.info("dispose: 所有 Subagent 已释放");
    }
}
