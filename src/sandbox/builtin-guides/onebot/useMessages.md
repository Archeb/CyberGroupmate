OneBotGuide: useMessages

本指南用于 OneBot/NapCat 的消息检索、已读、转发、合并转发和消息表情点赞等成组能力。普通发送、撤回、下载媒体仍优先使用 brief 中的顶层方法：`sendText`、`sendMedia`、`sendFile`、`deleteMessages`、`downloadMedia`。

## 执行入口

Guide 中的 NapCat 动作通过受控 passthrough 调用：

```ts
const result = await onebot.callApi("get_msg", { message_id: 123456 });
```

`onebot.callApi(action, params)` 只允许本指南和其他 OneBot guide 披露的 allowlist 动作。`action` 可带或不带开头 `/`。返回值是 NapCat 原始业务数据，字段以当前 NapCat 版本为准。

## 常用动作

- `get_msg`: 按消息 ID 获取消息详情。只想读取一条消息时也可以直接用顶层 `onebot.getMessage(messageId)`。
- `get_forward_msg`: 获取合并转发消息内容。
- `get_group_msg_history`: 拉取群历史消息，参数常用 `{ group_id, count, message_seq?, reverse_order? }`。
- `get_friend_msg_history`: 拉取好友私聊历史消息。
- `mark_msg_as_read` / `mark_group_msg_as_read` / `mark_private_msg_as_read` / `_mark_all_as_read`: 标记已读。
- `forward_friend_single_msg` / `forward_group_single_msg`: 转发单条消息。
- `send_forward_msg` / `send_group_forward_msg` / `send_private_forward_msg`: 发送合并转发。
- `set_msg_emoji_like`: 设置消息表情点赞。
- `get_emoji_likes` / `fetch_emoji_like`: 查询消息表情点赞。
- `group_poke`: 发送群戳一戳。

## 媒体和跨机器注意

NapCat 返回的 `file`/`path` 往往是 NapCat 所在机器的本地路径；CyberGroupmate 和 NapCat 分机部署时不要直接读取这些路径。需要拿到图片、语音、视频或文件内容时，优先：

```ts
const localPath = await onebot.downloadMedia(messageIdOrFileOrUrl);
```

`downloadMedia` 会优先走 `get_msg`、URL、base64/data URL，并把内容写到 CyberGroupmate 本机 `workspace/Downloads/`。

## 示例

```ts
const msg = await onebot.getMessage(123456);
console.log(msg.message ?? msg.raw_message);

const history = await onebot.callApi("get_group_msg_history", {
  group_id: 931351956,
  count: 20,
  reverse_order: false,
});

await onebot.callApi("forward_group_single_msg", {
  group_id: 931351956,
  message_id: 123456,
});
```
