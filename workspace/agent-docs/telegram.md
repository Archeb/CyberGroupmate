# Telegram 场景指南

## 核心边界

1. Telegram 连接、登录、消息接收、消息标准化已经由系统官方 `TelegramAdapter` 完成
2. 你**不需要也不允许**自己创建 `TelegramClient`
3. 你**不需要也不允许**自己建立 Telegram 消息监听器
4. 你在 `telegram` scene 中拿到的 `ctx.tg` 是系统注入的代码接口代理，可直接调用

补充：

- 如果系统配置为 `userbot` 模式，首次启动时宿主会要求人类输入 OTP 验证码
- 如果账号开启了两步验证，还会继续要求输入 2FA 密码
- 登录 session 会持久化到 `workspace/tg-session/account`

如果你需要处理新消息，请等待 NotificationCenter 把通知交给你；不要写 `runtime.spawn("tg-listener", ...)`。

## 发送消息

```javascript
scene.enter("telegram", { chatId: "-1001234567890" });

const sent = await ctx.tg.sendText("-1001234567890", "Hello!");
console.log("已发送, msgId=" + sent.id);

await ctx.tg.sendText("-1001234567890", "回复内容", { replyTo: 456 });
```

也可以用代码 skill：

```javascript
await skills.social.replyInTelegram("-1001234567890", "收到");
```

## 读取自身信息

```javascript
const me = await ctx.tg.getMe();
console.log(JSON.stringify(me, null, 2));
```

## 获取历史消息

```javascript
const messages = await ctx.tg.getHistory("-1001234567890", { limit: 20 });
for (const msg of messages) {
  console.log((msg.sender?.displayName || "?") + ": " + msg.text);
}
```

或者：

```javascript
for await (const msg of ctx.tg.iterHistory("-1001234567890", { limit: 20 })) {
  console.log(msg.text);
}
```

## 获取对话列表

```javascript
for await (const dialog of ctx.tg.iterDialogs({ limit: 20 })) {
  const name = dialog.peer.displayName || dialog.peer.title || "未知";
  console.log(name + " unread=" + dialog.unreadCount);
}
```

## 其他常用操作

```javascript
await ctx.tg.sendTyping("-1001234567890");
await ctx.tg.readHistory("-1001234567890");

const chat = await ctx.tg.getChat("-1001234567890");
const members = await ctx.tg.getChatMembers("-1001234567890", { limit: 20 });
console.log(chat.title, members.length);
```

## 推荐工作流

1. 在 `home` scene 看通知
2. 必要时切到 `memory` scene 做 recall / browseHistory
3. 切到 `telegram` scene 时优先带上焦点，例如 `scene.enter("telegram", { chatId })`
4. 在新的回合里用 `ctx.tg` 或 `skills.social.replyInTelegram()` 发消息
5. 结束当前回合，不要自己阻塞等待下一条 Telegram 消息

## 注意事项

1. `ctx.tg` 是宿主代理，不是你自己构造的 mtcute client
2. 返回的数据是普通对象，可直接 `console.log(JSON.stringify(...))`
3. 不要假设平台监听权在你手里；消息 ingress 由框架管理
4. `chatId` / `messageId` / `userId` 在系统内部统一按字符串处理
5. `scene.enter(...)` 是控制权切换，不要在同一代码块里先 `scene.enter(...)` 再继续发送消息
