OneBotGuide: useUsersAndProfile

本指南用于 OneBot/NapCat 的登录号信息、好友/陌生人资料、最近会话、点赞、好友请求和账号资料等成组能力。

## 执行入口

```ts
const me = await onebot.callApi("get_login_info", {});
```

`onebot.callApi(action, params)` 是 guide-only 的受控 NapCat passthrough；只允许 allowlist 动作。

## 查询动作

- `get_login_info`: 获取当前登录号基础信息。
- `get_friend_list`: 获取好友列表。
- `get_stranger_info`: 获取陌生人信息。
- `get_recent_contact`: 获取最近会话。
- `get_profile_like`: 获取资料点赞。
- `get_friends_with_category`: 获取带分组的好友列表。
- `get_unidirectional_friend_list`: 获取单向好友列表。
- `get_online_clients`: 获取在线客户端。
- `nc_get_user_status`: 获取用户在线状态。

## 写动作

- `send_like`: 给指定用户点赞。
- `set_friend_add_request`: 处理加好友请求。
- `set_friend_remark`: 设置好友备注。
- `set_qq_profile`: 设置 QQ 资料。
- `set_self_longnick`: 设置个性签名。
- `set_qq_avatar`: 设置 QQ 头像。
- `set_online_status`: 设置在线状态。
- `set_input_status`: 设置输入状态。
- `set_diy_online_status`: 设置自定义在线状态。

## 不暴露的敏感动作

凭证类动作不暴露：`get_cookies`、`get_csrf_token`、`get_credentials`、`get_clientkey`、`get_rkey`、`nc_get_rkey`。删除好友 `delete_friend` 也不通过 guide 暴露。

## 示例

```ts
const user = await onebot.callApi("get_stranger_info", {
  user_id: 724244020,
});

await onebot.callApi("send_like", {
  user_id: 724244020,
  times: 1,
});
```
