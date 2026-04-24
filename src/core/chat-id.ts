/**
 * chat-id.ts — Composite ChatId 工具函数
 *
 * 多平台集成中，chatId 使用 composite key 格式：
 * - 运行时格式：`{platform}:{rawId}`（如 `telegram:-1001234567`）
 * - 文件名格式：`{platform}_{rawId}`（`:` 在文件系统中不安全，用 `_` 替代）
 *
 * Discord 使用三段式：
 * - 运行时：`discord:{guildId}:{channelId}`
 * - 文件名：`discord_{guildId}_{channelId}`
 *
 * Telegram 使用二段式：
 * - 运行时：`telegram:{chatId}`
 * - 文件名：`telegram_{chatId}`
 */

/** 支持的平台名称 */
export type PlatformName = "telegram" | "discord" | "onebot";

/** parseChatId 的返回结构 */
export interface ParsedChatId {
    /** 平台名称 */
    platform: PlatformName;
    /** 原始 ID（完整，不含平台前缀） */
    rawId: string;
    /**
     * Discord Guild ID（仅 Discord 三段式有值）。
     * Telegram 群组本身即为 group，此字段为 undefined。
     */
    groupId?: string;
    /**
     * Discord Channel/Thread ID（仅 Discord 三段式有值）。
     * Telegram 无 channel 层，此字段为 undefined。
     */
    channelId?: string;
}

const VALID_PLATFORMS = new Set<string>(["telegram", "discord", "onebot"]);

/**
 * 创建 composite chatId。
 *
 * @example
 * composeChatId("telegram", "-1001234567")       → "telegram:-1001234567"
 * composeChatId("discord", "guild123", "chan456") → "discord:guild123:chan456"
 * composeChatId("discord", "user789")             → "discord:user789" (DM)
 */
export function composeChatId(platform: PlatformName, ...parts: string[]): string {
    if (!platform || !VALID_PLATFORMS.has(platform)) {
        throw new Error(`composeChatId: 无效的平台名 "${platform}"`);
    }
    if (parts.length === 0 || !parts[0]) {
        throw new Error("composeChatId: rawId 不能为空");
    }
    return `${platform}:${parts.join(":")}`;
}

/**
 * 解析 composite chatId。
 *
 * @example
 * parseChatId("telegram:-1001234567")
 *   → { platform: "telegram", rawId: "-1001234567" }
 *
 * parseChatId("discord:guild123:chan456")
 *   → { platform: "discord", rawId: "guild123:chan456", groupId: "guild123", channelId: "chan456" }
 *
 * parseChatId("discord:user789")
 *   → { platform: "discord", rawId: "user789" }  (DM, 无 groupId/channelId)
 */
export function parseChatId(compositeId: string): ParsedChatId {
    if (!compositeId) {
        throw new Error("parseChatId: compositeId 不能为空");
    }

    const colonIdx = compositeId.indexOf(":");
    if (colonIdx === -1) {
        throw new Error(
            `parseChatId: "${compositeId}" 不是有效的 composite chatId（缺少平台前缀）`,
        );
    }

    const platform = compositeId.slice(0, colonIdx);
    if (!VALID_PLATFORMS.has(platform)) {
        throw new Error(
            `parseChatId: 未知平台 "${platform}"（来自 "${compositeId}"）`,
        );
    }

    const rest = compositeId.slice(colonIdx + 1);
    if (!rest) {
        throw new Error(
            `parseChatId: "${compositeId}" rawId 部分为空`,
        );
    }

    const result: ParsedChatId = {
        platform: platform as PlatformName,
        rawId: rest,
    };

    // Discord 三段式: discord:guildId:channelId
    if (platform === "discord") {
        const secondColon = rest.indexOf(":");
        if (secondColon !== -1) {
            result.groupId = rest.slice(0, secondColon);
            result.channelId = rest.slice(secondColon + 1);
        }
        // 二段式 DM: discord:userId — 无 groupId/channelId
    }

    return result;
}

/**
 * 获取 composite chatId 的平台名。
 *
 * @example
 * getPlatform("telegram:-1001234567") → "telegram"
 * getPlatform("discord:guild:chan")    → "discord"
 */
export function getPlatform(compositeId: string): PlatformName {
    const colonIdx = compositeId.indexOf(":");
    if (colonIdx === -1) {
        throw new Error(
            `getPlatform: "${compositeId}" 不是有效的 composite chatId`,
        );
    }
    const platform = compositeId.slice(0, colonIdx);
    if (!VALID_PLATFORMS.has(platform)) {
        throw new Error(`getPlatform: 未知平台 "${platform}"`);
    }
    return platform as PlatformName;
}

/**
 * 判断 composite chatId 是否为 Discord 平台。
 */
export function isDiscord(compositeId: string): boolean {
    return compositeId.startsWith("discord:");
}

/**
 * 判断 composite chatId 是否为 Telegram 平台。
 */
export function isTelegram(compositeId: string): boolean {
    return compositeId.startsWith("telegram:");
}

/**
 * 判断 composite chatId 是否为 OneBot 平台。
 */
export function isOneBot(compositeId: string): boolean {
    return compositeId.startsWith("onebot:");
}

/**
 * 获取 GroupModel 的存储 key。
 *
 * Discord guild == group：同一 Guild 下的不同 Channel 共享 GroupModel。
 * - `discord:guildId:channelId` → `discord:guildId`
 * - `discord:userId` (DM)       → `discord:userId`（不变）
 * - `telegram:chatId`           → `telegram:chatId`（不变）
 *
 * @example
 * getGroupModelKey("discord:guild123:chan456") → "discord:guild123"
 * getGroupModelKey("discord:user789")         → "discord:user789"
 * getGroupModelKey("telegram:-1001234567")    → "telegram:-1001234567"
 */
export function getGroupModelKey(compositeId: string): string {
    if (!compositeId.startsWith("discord:")) return compositeId;
    const parsed = parseChatId(compositeId);
    if (parsed.groupId) {
        return composeChatId("discord", parsed.groupId);
    }
    return compositeId;
}
/**
 * 将 composite chatId 转换为文件系统安全的文件名。
 * `:` → `_`
 *
 * @example
 * chatIdToFileName("telegram:-1001234567")       → "telegram_-1001234567"
 * chatIdToFileName("discord:guild123:chan456")    → "discord_guild123_chan456"
 */
export function chatIdToFileName(compositeId: string): string {
    return compositeId.replaceAll(":", "_");
}

/**
 * 将文件名还原为 composite chatId。
 * 第一个 `_` 后的平台名确定后，后续的 `_` 按平台规则还原。
 *
 * @example
 * fileNameToChatId("telegram_-1001234567")       → "telegram:-1001234567"
 * fileNameToChatId("discord_guild123_chan456")    → "discord:guild123:chan456"
 */
export function fileNameToChatId(fileName: string): string {
    // 去掉 .json 等扩展名
    const base = fileName.replace(/\.[^.]+$/, "");

    const underscoreIdx = base.indexOf("_");
    if (underscoreIdx === -1) {
        throw new Error(
            `fileNameToChatId: "${fileName}" 不是有效的 composite chatId 文件名（缺少 _ 分隔符）`,
        );
    }

    const platform = base.slice(0, underscoreIdx);
    if (!VALID_PLATFORMS.has(platform)) {
        throw new Error(
            `fileNameToChatId: 未知平台 "${platform}"（来自 "${fileName}"）`,
        );
    }

    const rest = base.slice(underscoreIdx + 1);

    // Telegram: 二段式，直接还原 — telegram_-1001234567 → telegram:-1001234567
    // 注意 Telegram chatId 可能包含负号，不会与 _ 冲突
    if (platform === "telegram") {
        return `${platform}:${rest}`;
    }

    // OneBot: 三段式（onebot:group:xxx / onebot:private:xxx），需将 _ 还原为 :
    // onebot_group_679691983 → onebot:group:679691983
    if (platform === "onebot") {
        return `onebot:${rest.replaceAll("_", ":")}`;
    }

    // Discord: 需要将 _ 还原为 : — discord_guild_chan → discord:guild:chan
    if (platform === "discord") {
        return `discord:${rest.replaceAll("_", ":")}`;
    }

    return `${platform}:${rest}`;
}

/**
 * 获取 composite chatId 对应的 group 级别 ID。
 *
 * - Telegram: group 就是 chatId 本身（`telegram:-1001234567`）
 * - Discord: group 是 guild 级别（`discord:guild123`），如果是 DM 则返回自身
 *
 * 用于 GroupModel 的存储 key（Discord 下同一 Guild 的不同 Channel 共享画像）。
 */
export function getGroupChatId(compositeId: string): string {
    const parsed = parseChatId(compositeId);
    if (parsed.platform === "discord" && parsed.groupId) {
        return composeChatId("discord", parsed.groupId);
    }
    // Telegram 或 Discord DM: 自身即 group
    return compositeId;
}

/**
 * 判断 composite chatId 是否有效（包含已知平台前缀）。
 */
export function isValidCompositeChatId(compositeId: string): boolean {
    if (!compositeId) return false;
    const colonIdx = compositeId.indexOf(":");
    if (colonIdx === -1) return false;
    return VALID_PLATFORMS.has(compositeId.slice(0, colonIdx));
}

/**
 * 从 composite ID 中提取裸 ID（去掉平台前缀）。
 * 如果已经是裸 ID（没有平台前缀），原样返回。
 *
 * 用途：面向 LLM/sandbox 展示时，隐藏平台前缀。
 *
 * @example
 * getRawId("telegram:682932098")       → "682932098"
 * getRawId("discord:guild:chan")        → "guild:chan"
 * getRawId("682932098")                → "682932098"  (已经是裸 ID)
 * getRawId("agent")                    → "agent"      (非 composite，原样返回)
 */
export function getRawId(compositeOrRawId: string): string {
    if (!compositeOrRawId) return compositeOrRawId;
    const colonIdx = compositeOrRawId.indexOf(":");
    if (colonIdx === -1) return compositeOrRawId;  // 无 `:` → 已经是裸 ID
    const maybePlatform = compositeOrRawId.slice(0, colonIdx);
    if (VALID_PLATFORMS.has(maybePlatform)) {
        return compositeOrRawId.slice(colonIdx + 1);
    }
    return compositeOrRawId;  // `:` 存在但不是已知平台前缀 → 原样返回
}

/**
 * 确保 ID 为 composite 格式。如果已有平台前缀则原样返回，
 * 否则自动加上指定平台的前缀。
 *
 * 用途：sandbox 传入的 raw chatId 自动补全为 composite key 做安全检查。
 *
 * @example
 * ensureCompositeId("telegram", "682932098")            → "telegram:682932098"
 * ensureCompositeId("telegram", "telegram:682932098")   → "telegram:682932098"  (已有前缀)
 * ensureCompositeId("telegram", "-1001234567")           → "telegram:-1001234567"
 */
export function ensureCompositeId(platform: PlatformName, id: string): string {
    if (isValidCompositeChatId(id)) return id;
    return composeChatId(platform, id);
}

// ─── Dunbar Tier 标签 ───

/** 全局统一的 Dunbar Tier 中文标签映射 */
export const DUNBAR_TIER_LABELS: Record<number, string> = {
    1: "好友",
    2: "认识",
    3: "生疏",
    4: "陌生",
};

/**
 * 获取 Dunbar Tier 的中文显示标签。
 *
 * @example
 * getDunbarTierLabel(1)         → "亲密程度: 好友"
 * getDunbarTierLabel(undefined) → "不熟"
 * getDunbarTierLabel(99)        → "亲密程度: Tier99"
 */
export function getDunbarTierLabel(tier: number | undefined | null): string {
    if (!tier) return "不熟";
    return `亲密程度: ${DUNBAR_TIER_LABELS[tier] ?? `Tier${tier}`}`;
}
