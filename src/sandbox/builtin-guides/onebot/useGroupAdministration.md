OneBotGuide: useGroupAdministration

本指南用于 OneBot/NapCat 的群信息、成员信息、禁言、管理、公告、精华消息和群待办等成组能力。管理类写操作会改变群状态，执行前要确认目标群和对象。

## 执行入口

```ts
const info = await onebot.callApi("get_group_info", { group_id: 123456 });
```

`onebot.callApi(action, params)` 是 guide-only 的受控 NapCat passthrough；不在 brief 常驻展开，且只允许 allowlist 动作。

## 查询动作

- `get_group_list`: 获取群列表。
- `get_group_info`: 获取群基础信息。
- `get_group_detail_info`: 获取群详细信息。
- `get_group_member_info`: 获取单个群成员资料。
- `get_group_member_list`: 获取群成员列表。
- `get_group_honor_info`: 获取群荣誉信息。
- `get_group_at_all_remain`: 获取 @全体 剩余次数。
- `get_group_shut_list`: 获取群禁言列表。
- `_get_group_notice`: 获取群公告。
- `get_essence_msg_list`: 获取群精华消息。

## 管理动作

- `set_group_ban`: 禁言或解除禁言群成员，`duration=0` 表示解除。
- `set_group_whole_ban`: 开启或关闭全员禁言。
- `set_group_kick` / `set_group_kick_members`: 踢出成员。
- `set_group_admin`: 设置或取消管理员。
- `set_group_name`: 修改群名。
- `set_group_card`: 修改群成员名片。
- `set_group_special_title`: 设置专属头衔。
- `set_group_add_request`: 处理加群请求或邀请。
- `set_group_remark`: 设置群备注。
- `_send_group_notice` / `_del_group_notice`: 发送或删除群公告。
- `set_essence_msg` / `delete_essence_msg`: 设置或移出精华消息。
- `set_group_todo` / `complete_group_todo` / `cancel_group_todo`: 设置、完成或取消群待办。

## 不暴露的高风险动作

`set_group_leave` 不通过 guide 暴露。退群或解散群属于高风险破坏性操作，需要人工处理或单独增加更强的确认流程。

## 示例

```ts
const member = await onebot.callApi("get_group_member_info", {
  group_id: 931351956,
  user_id: 724244020,
});

await onebot.callApi("set_group_ban", {
  group_id: 931351956,
  user_id: 724244020,
  duration: 60,
});

await onebot.callApi("set_essence_msg", { message_id: 123456 });
```
