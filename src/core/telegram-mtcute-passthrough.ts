/**
 * mtcute high-level methods that are intentionally exposed through Telegram
 * built-in guides. The sandbox proxy calls them through one generic host call,
 * so adding a new guide usually only needs updating this list and the guide doc.
 */

export const TELEGRAM_MTCUTE_GUIDE_METHODS = {
    accountProfile: [
        "updateProfile",
        "setMyUsername",
        "getMyUsername",
        "reorderUsernames",
        "toggleFragmentUsername",
        "setEmojiStatus",
        "setMyBirthday",
        "setMyProfilePhoto",
        "deleteProfilePhotos",
        "getProfilePhoto",
        "getProfilePhotos",
        "iterProfilePhotos",
        "editCloseFriends",
    ],

    advancedMessages: [
        "answerText",
        "answerMedia",
        "answerMediaGroup",
        "commentText",
        "commentMedia",
        "commentMediaGroup",
        "sendCopy",
        "sendCopyGroup",
        "quoteWithText",
        "quoteWithMedia",
        "quoteWithMediaGroup",
        "replyText",
        "replyMedia",
        "replyMediaGroup",
        "getDiscussionMessage",
        "getFactCheck",
        "getMessageByLink",
        "getMessageGroup",
        "getReactionUsers",
        "iterReactionUsers",
        "getReplyTo",
        "getScheduledMessages",
        "getAllScheduledMessages",
        "deleteScheduledMessages",
        "sendScheduled",
        "getWebPagePreview",
    ],

    chatAdministration: [
        "createGroup",
        "createSupergroup",
        "createChannel",
        "setChatTitle",
        "setChatDescription",
        "setChatPhoto",
        "deleteChatPhoto",
        "setChatUsername",
        "setChatColor",
        "setChatTtl",
        "setSlowMode",
        "toggleContentProtection",
        "setChatDefaultPermissions",
        "addChatMembers",
        "banChatMember",
        "kickChatMember",
        "restrictChatMember",
        "unrestrictChatMember",
        "unbanChatMember",
        "editAdminRights",
        "editChatMemberRank",
        "getChatEventLog",
        "iterChatEventLog",
    ],

    invites: [
        "createInviteLink",
        "editInviteLink",
        "exportInviteLink",
        "getInviteLink",
        "getInviteLinks",
        "iterInviteLinks",
        "getPrimaryInviteLink",
        "getInviteLinkMembers",
        "iterInviteLinkMembers",
        "revokeInviteLink",
        "hideJoinRequest",
        "hideAllJoinRequests",
        "toggleJoinRequests",
        "toggleJoinToSend",
        "getChatPreview",
    ],

    forumTopics: [
        "getForumTopics",
        "getForumTopicsById",
        "iterForumTopics",
        "createForumTopic",
        "editForumTopic",
        "deleteForumTopicHistory",
        "toggleForumTopicClosed",
        "toggleForumTopicPinned",
        "toggleGeneralTopicHidden",
        "reorderPinnedForumTopics",
        "updateForumSettings",
    ],

    stories: [
        "canSendStory",
        "getAllStories",
        "iterAllStories",
        "getPeerStories",
        "getProfileStories",
        "iterProfileStories",
        "getStoriesById",
        "getStoriesInteractions",
        "getStoryLink",
        "getStoryViewers",
        "iterStoryViewers",
        "readStories",
        "incrementStoriesViews",
        "hideMyStoriesViews",
        "sendStory",
        "editStory",
        "deleteStories",
        "toggleStoriesPinned",
        "togglePeerStoriesArchived",
        "sendStoryReaction",
    ],

    pollsAndTodos: [
        "closePoll",
        "sendVote",
        "appendTodoList",
        "toggleTodoCompleted",
    ],
} as const;

const SESSION_LIFECYCLE_METHODS = new Set([
    "start",
    "startTest",
    "signIn",
    "signInBot",
    "signInQr",
    "sendCode",
    "resendCode",
    "logOut",
]);

export const TELEGRAM_MTCUTE_PASSTHROUGH_METHODS: ReadonlySet<string> = new Set(
    Object.values(TELEGRAM_MTCUTE_GUIDE_METHODS).flat(),
);

export function isAllowedTelegramMtcutePassthroughMethod(methodName: string): boolean {
    return TELEGRAM_MTCUTE_PASSTHROUGH_METHODS.has(methodName) && !SESSION_LIFECYCLE_METHODS.has(methodName);
}

export const TELEGRAM_MTCUTE_WRITE_METHODS = new Set([
    "answerMedia",
    "answerMediaGroup",
    "answerText",
    "commentMedia",
    "commentMediaGroup",
    "commentText",
    "sendCopy",
    "sendCopyGroup",
    "quoteWithMedia",
    "quoteWithMediaGroup",
    "quoteWithText",
    "replyMedia",
    "replyMediaGroup",
    "replyText",
    "deleteScheduledMessages",
    "sendScheduled",
    "createGroup",
    "createSupergroup",
    "createChannel",
    "setChatTitle",
    "setChatDescription",
    "setChatPhoto",
    "deleteChatPhoto",
    "setChatUsername",
    "setChatColor",
    "setChatTtl",
    "setSlowMode",
    "toggleContentProtection",
    "setChatDefaultPermissions",
    "addChatMembers",
    "banChatMember",
    "kickChatMember",
    "restrictChatMember",
    "unrestrictChatMember",
    "unbanChatMember",
    "editAdminRights",
    "editChatMemberRank",
    "createInviteLink",
    "editInviteLink",
    "exportInviteLink",
    "revokeInviteLink",
    "hideJoinRequest",
    "hideAllJoinRequests",
    "toggleJoinRequests",
    "toggleJoinToSend",
    "createForumTopic",
    "editForumTopic",
    "deleteForumTopicHistory",
    "toggleForumTopicClosed",
    "toggleForumTopicPinned",
    "toggleGeneralTopicHidden",
    "reorderPinnedForumTopics",
    "updateForumSettings",
    "readStories",
    "incrementStoriesViews",
    "hideMyStoriesViews",
    "sendStory",
    "editStory",
    "deleteStories",
    "toggleStoriesPinned",
    "togglePeerStoriesArchived",
    "sendStoryReaction",
    "closePoll",
    "sendVote",
    "appendTodoList",
    "toggleTodoCompleted",
    "updateProfile",
    "setMyUsername",
    "reorderUsernames",
    "toggleFragmentUsername",
    "setEmojiStatus",
    "setMyBirthday",
    "setMyProfilePhoto",
    "deleteProfilePhotos",
    "editCloseFriends",
]);

function getObjectTarget(value: unknown, keys: string[]): unknown {
    if (!value || typeof value !== "object") return undefined;
    const raw = value as Record<string, unknown>;
    for (const key of keys) {
        if (raw[key] != null) return raw[key];
    }
    return undefined;
}

export function getTelegramMtcuteWriteTarget(methodName: string, args: unknown[]): unknown {
    switch (methodName) {
        case "sendCopy":
        case "sendCopyGroup":
            return getObjectTarget(args[0], ["toChatId"]);
        case "deleteScheduledMessages":
        case "sendScheduled":
            return args[0];
        case "createInviteLink":
        case "editInviteLink":
        case "hideJoinRequest":
        case "hideAllJoinRequests":
        case "createForumTopic":
        case "editForumTopic":
        case "reorderPinnedForumTopics":
        case "toggleForumTopicClosed":
        case "toggleForumTopicPinned":
        case "toggleGeneralTopicHidden":
        case "setChatColor":
        case "setChatPhoto":
        case "banChatMember":
        case "kickChatMember":
        case "restrictChatMember":
        case "unrestrictChatMember":
        case "unbanChatMember":
        case "editAdminRights":
        case "editChatMemberRank":
            return getObjectTarget(args[0], ["chatId", "chat", "peer", "peerId"]);
        case "deleteForumTopicHistory":
        case "updateForumSettings":
            return args[0];
        case "setChatTitle":
        case "setChatDescription":
        case "deleteChatPhoto":
        case "setChatUsername":
        case "setChatTtl":
        case "setSlowMode":
        case "toggleContentProtection":
        case "setChatDefaultPermissions":
        case "addChatMembers":
        case "exportInviteLink":
        case "revokeInviteLink":
        case "toggleJoinRequests":
        case "toggleJoinToSend":
            return args[0];
        case "sendStory":
        case "editStory":
        case "deleteStories":
        case "toggleStoriesPinned":
            return getObjectTarget(args[0], ["peer", "peerId"]) ?? "me";
        case "sendStoryReaction":
            return getObjectTarget(args[0], ["peer", "peerId"]) ?? args[0];
        default:
            return undefined;
    }
}
