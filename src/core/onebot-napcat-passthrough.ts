/**
 * onebot-napcat-passthrough.ts — curated NapCat action exposure
 *
 * NapCat exposes a wide OneBot-compatible action surface. Keep common,
 * single-step CyberGroupmate APIs at the top level and expose the rest only
 * through guide-gated, allowlisted passthrough actions.
 */

export const ONEBOT_NAPCAT_GUIDE_ACTIONS = {
    messages: [
        "get_msg",
        "get_forward_msg",
        "get_group_msg_history",
        "get_friend_msg_history",
        "mark_msg_as_read",
        "mark_group_msg_as_read",
        "mark_private_msg_as_read",
        "_mark_all_as_read",
        "forward_friend_single_msg",
        "forward_group_single_msg",
        "send_forward_msg",
        "send_group_forward_msg",
        "send_private_forward_msg",
        "set_msg_emoji_like",
        "get_emoji_likes",
        "fetch_emoji_like",
        "group_poke",
    ],
    groupAdministration: [
        "get_group_list",
        "get_group_info",
        "get_group_detail_info",
        "get_group_member_info",
        "get_group_member_list",
        "get_group_honor_info",
        "get_group_at_all_remain",
        "get_group_shut_list",
        "set_group_ban",
        "set_group_whole_ban",
        "set_group_kick",
        "set_group_kick_members",
        "set_group_admin",
        "set_group_name",
        "set_group_card",
        "set_group_special_title",
        "set_group_add_request",
        "set_group_remark",
        "_send_group_notice",
        "_get_group_notice",
        "_del_group_notice",
        "set_essence_msg",
        "delete_essence_msg",
        "get_essence_msg_list",
        "set_group_todo",
        "complete_group_todo",
        "cancel_group_todo",
    ],
    files: [
        "get_image",
        "get_record",
        "get_file",
        "get_group_file_url",
        "get_private_file_url",
        "get_group_root_files",
        "get_group_files_by_folder",
        "get_group_file_system_info",
        "upload_group_file",
        "upload_private_file",
        "delete_group_file",
        "create_group_file_folder",
        "delete_group_folder",
        "move_group_file",
        "rename_group_file",
        "trans_group_file",
    ],
    usersAndProfile: [
        "get_login_info",
        "get_friend_list",
        "get_stranger_info",
        "get_recent_contact",
        "get_profile_like",
        "get_friends_with_category",
        "get_unidirectional_friend_list",
        "get_online_clients",
        "send_like",
        "set_friend_add_request",
        "set_friend_remark",
        "set_qq_profile",
        "set_self_longnick",
        "set_qq_avatar",
        "set_online_status",
        "set_input_status",
        "set_diy_online_status",
        "nc_get_user_status",
    ],
    utilities: [
        "get_version_info",
        "get_status",
        "can_send_image",
        "can_send_record",
        "nc_get_packet_status",
        "ocr_image",
        "translate_en2zh",
        "check_url_safely",
        "get_guild_list",
        "get_guild_service_profile",
        "get_ai_characters",
        "get_ai_record",
        "send_group_ai_record",
    ],
} as const;

export type OneBotNapCatGuideGroup = keyof typeof ONEBOT_NAPCAT_GUIDE_ACTIONS;

export const ONEBOT_NAPCAT_WRITE_ACTIONS = new Set<string>([
    "mark_msg_as_read",
    "mark_group_msg_as_read",
    "mark_private_msg_as_read",
    "_mark_all_as_read",
    "forward_friend_single_msg",
    "forward_group_single_msg",
    "send_forward_msg",
    "send_group_forward_msg",
    "send_private_forward_msg",
    "set_msg_emoji_like",
    "group_poke",
    "set_group_ban",
    "set_group_whole_ban",
    "set_group_kick",
    "set_group_kick_members",
    "set_group_admin",
    "set_group_name",
    "set_group_card",
    "set_group_special_title",
    "set_group_add_request",
    "set_group_remark",
    "_send_group_notice",
    "_del_group_notice",
    "set_essence_msg",
    "delete_essence_msg",
    "set_group_todo",
    "complete_group_todo",
    "cancel_group_todo",
    "upload_group_file",
    "upload_private_file",
    "delete_group_file",
    "create_group_file_folder",
    "delete_group_folder",
    "move_group_file",
    "rename_group_file",
    "trans_group_file",
    "send_like",
    "set_friend_add_request",
    "set_friend_remark",
    "set_qq_profile",
    "set_self_longnick",
    "set_qq_avatar",
    "set_online_status",
    "set_input_status",
    "set_diy_online_status",
    "send_group_ai_record",
]);

export const ONEBOT_NAPCAT_EXCLUDED_ACTIONS = new Set<string>([
    "get_cookies",
    "get_csrf_token",
    "get_credentials",
    "get_clientkey",
    "get_rkey",
    "get_rkey_server",
    "nc_get_rkey",
    "send_packet",
    "bot_exit",
    "set_restart",
    "clean_cache",
    "set_group_leave",
    "delete_friend",
]);

const ALLOWED_ACTIONS = new Set<string>(
    Object.values(ONEBOT_NAPCAT_GUIDE_ACTIONS).flat(),
);

export function normalizeOneBotNapCatAction(action: string): string {
    return action.trim().replace(/^\/+/, "");
}

export function isAllowedOneBotNapCatAction(action: string): boolean {
    return ALLOWED_ACTIONS.has(normalizeOneBotNapCatAction(action));
}

export function getOneBotNapCatGuideGroupForAction(action: string): OneBotNapCatGuideGroup | undefined {
    const normalized = normalizeOneBotNapCatAction(action);
    for (const [group, actions] of Object.entries(ONEBOT_NAPCAT_GUIDE_ACTIONS) as Array<[OneBotNapCatGuideGroup, readonly string[]]>) {
        if (actions.includes(normalized)) return group;
    }
    return undefined;
}

export function isOneBotNapCatWriteAction(action: string): boolean {
    return ONEBOT_NAPCAT_WRITE_ACTIONS.has(normalizeOneBotNapCatAction(action));
}

function compositeChatId(kind: "group" | "private", value: unknown): string | undefined {
    if (value == null || value === "") return undefined;
    return `onebot:${kind}:${String(value)}`;
}

export function getOneBotNapCatWriteTarget(action: string, params: unknown): string | undefined {
    const normalized = normalizeOneBotNapCatAction(action);
    if (!isOneBotNapCatWriteAction(normalized)) return undefined;
    const rec = params && typeof params === "object" ? params as Record<string, unknown> : {};

    if (rec.group_id != null) return compositeChatId("group", rec.group_id);
    if (rec.user_id != null) {
        if (
            normalized.includes("private")
            || normalized.includes("friend")
            || normalized === "send_like"
            || normalized === "set_friend_add_request"
            || normalized === "set_friend_remark"
        ) {
            return compositeChatId("private", rec.user_id);
        }
    }
    return undefined;
}
