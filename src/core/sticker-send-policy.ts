import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("sticker-policy");

export type StickerSendingMode = "allow_all" | "allow_listed" | "disallow_all";

/** 贴纸库只读接口（MemoryStoreV2 的子集，便于测试替身） */
export interface StickerPolicyStore {
    getStickerDescription(uniqueFileId: string): { description: string; emoji?: string; emojis?: string[]; enabled?: boolean } | null;
    getAllStickerDescriptions(): Array<{ uniqueFileId: string; description: string; emoji?: string; emojis?: string[]; enabled: boolean }>;
}

export interface StickerSearchQuery {
    /** 按贴纸关联 emoji 过滤 */
    emoji?: string | string[];
    /** 按描述关键词过滤（多个关键词为 AND 关系） */
    keywords?: string | string[];
    /** 返回条数上限，默认 12，最大 50 */
    limit?: number;
}

export interface StickerSearchResult {
    uniqueFileId: string;
    description: string;
    emojis: string[];
    enabled: boolean;
}

export interface StickerSendCheckOptions {
    /** 触发校验的方法名，用于报错定位 */
    method?: string;
    /** 报错时引导 agent 使用的搜索 API（如 telegram.searchStickers） */
    searchApi?: string;
}

/**
 * 贴纸发送策略 — 在发送链路上强制执行 vision.sticker_sending_mode：
 * - allow_all：不限制（默认）
 * - allow_listed：仅允许 Dashboard 中启用（enabled=true）的贴纸
 * - disallow_all：完全禁止发送贴纸
 *
 * 同时提供 searchStickers()，让 agent 只检索当前策略下可发送的贴纸。
 */
export class StickerSendPolicy {
    constructor(
        private readonly store: StickerPolicyStore,
        private readonly getMode: () => StickerSendingMode | undefined =
            () => loadConfig().vision?.stickerSendingMode,
    ) {}

    get mode(): StickerSendingMode {
        return this.getMode() ?? "allow_all";
    }

    /**
     * 校验一次贴纸发送是否被策略允许，不允许时抛错。
     * 报错信息会引导 agent 改用搜索 API 查找可发送的贴纸。
     */
    assertSendAllowed(uniqueFileId?: string, options: StickerSendCheckOptions = {}): void {
        const mode = this.mode;
        const method = options.method ?? "sendSticker";
        if (mode === "disallow_all") {
            log.info("贴纸发送被策略拦截", { mode, method, uniqueFileId });
            throw new Error(
                `${method}: 贴纸发送被策略拦截 — 当前 vision.sticker_sending_mode 为 disallow_all，禁止发送任何贴纸`,
            );
        }
        if (mode !== "allow_listed") return;

        if (!uniqueFileId) {
            log.info("贴纸发送被策略拦截", { mode, method, uniqueFileId });
            throw new Error(this.buildRejection(method, options.searchApi, "缺少 uniqueFileId，无法核对允许列表"));
        }
        const entry = this.store.getStickerDescription(uniqueFileId);
        if (!entry || entry.enabled !== true) {
            log.info("贴纸发送被策略拦截", { mode, method, uniqueFileId, known: entry !== null });
            throw new Error(this.buildRejection(
                method,
                options.searchApi,
                `贴纸 ${uniqueFileId} 不在允许列表（需在 Dashboard 贴纸面板启用）`,
            ));
        }
    }

    /** 搜索当前策略下可发送的贴纸；disallow_all 恒返回空 */
    searchStickers(query: StickerSearchQuery = {}): StickerSearchResult[] {
        const mode = this.mode;
        if (mode === "disallow_all") return [];

        const limit = Math.max(1, Math.min(50, Math.floor(query.limit ?? 12)));
        const emojis = normalizeQueryEmojis(query.emoji);
        const keywords = normalizeQueryKeywords(query.keywords);

        const results: StickerSearchResult[] = [];
        const seen = new Set<string>();
        for (const entry of this.store.getAllStickerDescriptions()) {
            if (mode === "allow_listed" && !entry.enabled) continue;
            const entryEmojis = entry.emojis?.length ? entry.emojis : (entry.emoji ? [entry.emoji] : []);
            if (emojis.length > 0 && !emojis.some(emoji => entryEmojis.includes(emoji))) continue;
            if (keywords.length > 0 && !matchesAllKeywords(entry.description, keywords)) continue;
            if (seen.has(entry.uniqueFileId)) continue;
            seen.add(entry.uniqueFileId);
            results.push({
                uniqueFileId: entry.uniqueFileId,
                description: entry.description,
                emojis: entryEmojis,
                enabled: entry.enabled,
            });
            if (results.length >= limit) break;
        }
        return results;
    }

    private buildRejection(method: string, searchApi: string | undefined, reason: string): string {
        const lines = [
            `${method}: 贴纸发送被策略拦截 — ${reason}`,
            "当前 vision.sticker_sending_mode 为 allow_listed，只能发送允许列表中的贴纸。",
        ];
        if (searchApi) {
            lines.push(`请改用 ${searchApi}({ emoji 或 keywords, limit }) 搜索当前允许发送的贴纸，再用返回的 uniqueFileId 重新发送。`);
        } else {
            lines.push("请改用当前平台的 searchStickers 搜索允许发送的贴纸后重试。");
        }
        return lines.join("\n");
    }
}

function normalizeQueryEmojis(emoji: string | string[] | undefined): string[] {
    const raw = Array.isArray(emoji) ? emoji : (emoji !== undefined ? [emoji] : []);
    return raw.map(item => String(item).trim()).filter(Boolean);
}

function normalizeQueryKeywords(keywords: string | string[] | undefined): string[] {
    const raw = Array.isArray(keywords) ? keywords : (keywords !== undefined ? [keywords] : []);
    return raw
        .flatMap(item => String(item).split(/\s+/))
        .map(item => item.trim().toLowerCase())
        .filter(Boolean);
}

function matchesAllKeywords(description: string, keywords: string[]): boolean {
    const haystack = description.toLowerCase();
    return keywords.every(keyword => haystack.includes(keyword));
}
