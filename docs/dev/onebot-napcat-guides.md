# OneBot NapCat Guides

本文档记录 OneBot/NapCat 内置 guide 的维护方式。设计参考 Telegram mtcute guides：顶层 brief 只保留高频、单步、语义稳定的 CyberGroupmate API；NapCat 的大面接口通过 `onebot.useXxx()` guide 按需披露，并用受控 `onebot.callApi()` passthrough 执行。

## 设计目标

NapCat 的 API 面覆盖消息、群管理、文件、用户资料、系统状态、扩展能力和敏感凭证，不适合全部常驻放进 Agent brief。项目把低频、流程型、成组使用的能力收束成 guide：

```ts
await onebot.useMessages();
await onebot.useGroupAdministration();
await onebot.useFiles();
await onebot.useUsersAndProfile();
await onebot.useSystemUtilities();
```

`useXxx()` 本身不会执行 QQ 操作，只会触发 Pass 2 注入完整说明。真正执行时，Agent 调用 guide 中披露的：

```ts
await onebot.callApi("get_group_info", { group_id: 123456 });
```

`sendText()`、`sendMedia()`、`downloadMedia()` 这类一行就能表达用户意图的函数仍然常驻暴露。

## 顶层 brief API

适合放在一级 API 的标准：

- 高频：群聊回复、发图、发表情、撤回、下载媒体、精确读取一条消息。
- 单步语义：调用名本身已经表达用户意图，不需要先学习一组 NapCat 参数。
- 项目封装有额外保护：重复发送拦截、绑定聊天写限制、humanized delay、跨机器文件转 data URL、媒体落盘到 CyberGroupmate workspace。

当前保留：

- `sendText`
- `sendMedia`
- `sendFile`
- `sendSticker`
- `sendFace`
- `sendTyping`
- `deleteMessages`
- `downloadMedia`
- `getMessage`

`downloadMedia()` 特别注意跨机器部署：可直接传 OneBot 消息 ID、媒体 file、URL、base64 或 data URL；实现会优先走 `get_msg`、URL/base64，并把内容写到 CyberGroupmate 本机 `workspace/Downloads/`。不要让 Agent 直接读取 NapCat 返回的本地 `file`/`path`。

## Guide 分类

### `useMessages`

消息检索、历史、已读、转发、合并转发、消息表情点赞、戳一戳。

包含典型动作：

- `get_msg`
- `get_forward_msg`
- `get_group_msg_history`
- `get_friend_msg_history`
- `mark_msg_as_read`
- `mark_group_msg_as_read`
- `mark_private_msg_as_read`
- `_mark_all_as_read`
- `forward_friend_single_msg`
- `forward_group_single_msg`
- `send_forward_msg`
- `send_group_forward_msg`
- `send_private_forward_msg`
- `set_msg_emoji_like`
- `get_emoji_likes`
- `fetch_emoji_like`
- `group_poke`

### `useGroupAdministration`

群资料、成员、禁言、踢人、管理员、公告、精华消息、群待办。

包含典型动作：

- `get_group_list`
- `get_group_info`
- `get_group_detail_info`
- `get_group_member_info`
- `get_group_member_list`
- `get_group_honor_info`
- `get_group_at_all_remain`
- `get_group_shut_list`
- `set_group_ban`
- `set_group_whole_ban`
- `set_group_kick`
- `set_group_kick_members`
- `set_group_admin`
- `set_group_name`
- `set_group_card`
- `set_group_special_title`
- `set_group_add_request`
- `set_group_remark`
- `_send_group_notice`
- `_get_group_notice`
- `_del_group_notice`
- `set_essence_msg`
- `delete_essence_msg`
- `get_essence_msg_list`
- `set_group_todo`
- `complete_group_todo`
- `cancel_group_todo`

### `useFiles`

图片、语音、文件 URL、群文件系统、私聊文件和群文件目录。

包含典型动作：

- `get_image`
- `get_record`
- `get_file`
- `get_group_file_url`
- `get_private_file_url`
- `get_group_root_files`
- `get_group_files_by_folder`
- `get_group_file_system_info`
- `upload_group_file`
- `upload_private_file`
- `delete_group_file`
- `create_group_file_folder`
- `delete_group_folder`
- `move_group_file`
- `rename_group_file`
- `trans_group_file`

文件类 guide 必须反复强调跨机器语义：NapCat 的“本地路径”是 NapCat 机器路径。普通发送文件优先使用顶层 `sendFile()`；读取媒体内容优先使用顶层 `downloadMedia()`；`upload_group_file` 等原生动作优先传 HTTP(S) URL 或 NapCat 自己能访问的路径。

### `useUsersAndProfile`

登录号、好友、陌生人、最近会话、用户在线状态、点赞、好友请求和账号资料。

包含典型动作：

- `get_login_info`
- `get_friend_list`
- `get_stranger_info`
- `get_recent_contact`
- `get_profile_like`
- `get_friends_with_category`
- `get_unidirectional_friend_list`
- `get_online_clients`
- `send_like`
- `set_friend_add_request`
- `set_friend_remark`
- `set_qq_profile`
- `set_self_longnick`
- `set_qq_avatar`
- `set_online_status`
- `set_input_status`
- `set_diy_online_status`
- `nc_get_user_status`

### `useSystemUtilities`

状态探测、发送能力检查、OCR、URL 安全检查、频道资料和 AI 语音。

包含典型动作：

- `get_version_info`
- `get_status`
- `can_send_image`
- `can_send_record`
- `nc_get_packet_status`
- `ocr_image`
- `translate_en2zh`
- `check_url_safely`
- `get_guild_list`
- `get_guild_service_profile`
- `get_ai_characters`
- `get_ai_record`
- `send_group_ai_record`

## 默认不暴露

默认不通过 guide 暴露：

- 凭证和 cookie：`get_cookies`、`get_csrf_token`、`get_credentials`、`get_clientkey`、`get_rkey`、`nc_get_rkey`。
- 原始包和服务控制：`send_packet`、`bot_exit`、`set_restart`、`clean_cache`。
- 高风险破坏动作：`set_group_leave`、`delete_friend`。
- 大量相册、闪传、收藏、机型伪装等低频扩展，等有明确需求再分 guide。

## 关键文件

- `src/core/onebot-napcat-passthrough.ts`
  - `ONEBOT_NAPCAT_GUIDE_ACTIONS`：按 guide 分组列出允许转发的 NapCat actions。
  - `ONEBOT_NAPCAT_WRITE_ACTIONS`：会改变 QQ/NapCat 状态的写动作集合。
  - `getOneBotNapCatWriteTarget()`：从写动作参数中提取目标 chat，用于绑定聊天写限制。
- `src/sandbox/builtin-guides/onebot/`
  - 手写 OneBot/NapCat guide。
- `src/sandbox/builtin-guides.ts`
  - 注册 `onebot.useXxx()` guide，并提供 Pass 1 brief。
- `src/sandbox/modules/onebot/onebot.d.ts`
  - 暴露给 Agent 的 OneBot brief 类型定义。
- `src/sandbox/modules/onebot/index.ts`
  - `useXxx()` activator、顶层封装和 guide-only `callApi()` sandbox proxy。
- `src/adapter/onebot-adapter.ts`
  - `onebot.callApi` host call 按 allowlist 转发给 NapCat websocket action。

## 新增 guide 或动作

如果新增 NapCat action：

1. 在 NapCat llms 索引中确认接口存在，再打开对应 `.md` 看真实 path 和参数。
2. 判断它是否应该是顶层单步语义，还是属于某个 guide。
3. Guide 动作加入 `src/core/onebot-napcat-passthrough.ts` 的 `ONEBOT_NAPCAT_GUIDE_ACTIONS`。
4. 如果动作会改变状态，加入 `ONEBOT_NAPCAT_WRITE_ACTIONS`。
5. 如果写动作作用于某个群或私聊，在 `getOneBotNapCatWriteTarget()` 中补目标提取逻辑。
6. 更新对应 `src/sandbox/builtin-guides/onebot/use*.md`。
7. 如果新增 `useXxx()` 分类，同步修改：
   - `src/sandbox/builtin-guides.ts`
   - `src/sandbox/modules/onebot/onebot.d.ts`
   - `src/sandbox/modules/onebot/index.ts`
   - guide 相关测试
8. 运行：

```bash
npm run gen:module-docs
npx tsc --noEmit
npx tsx --test tests/onebot-adapter.test.ts tests/onebot-proxy-download.test.ts tests/onebot-guides.test.ts
```

## 资料来源

- NapCat llms 索引：https://napcat.apifox.cn/llms.txt
- NapCat `get_msg`：https://napcat.apifox.cn/226656707e0.md
- NapCat `get_image`：https://napcat.apifox.cn/226657066e0.md
- NapCat `get_group_msg_history`：https://napcat.apifox.cn/226657401e0.md
- NapCat `upload_group_file`：https://napcat.apifox.cn/226658753e0.md
