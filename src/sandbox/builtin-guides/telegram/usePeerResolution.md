## 什么时候使用

当 Telegram 报 `PEER_ID_INVALID`、`MtPeerNotFoundError`、`access hash` 相关错误，或你只有裸数字 user id 但当前 session 没见过这个人时，先阅读本指南。

## 可用 API

```ts
telegram.getDialogs(opts?: { limit?: number }): Promise<Dialog[]>;

telegram.findDialogs(
  peers: string | number | Array<string | number>,
  opts?: { limit?: number }
): Promise<Dialog[]>;

telegram.meetPeer(
  peer: string | number,
  opts?: {
    kind?: "id" | "username" | "phone";
    chatId?: string | number;
    messageIds?: number[];
    dialogsLimit?: number;
    force?: boolean;
  }
): Promise<{ ok: true; input: string; source: { type: string; id?: string; value?: string } }>;

telegram.resolvePeer(...): Promise<...>; // meetPeer 的别名
```

## 推荐修复顺序

1. 有 username：`await telegram.meetPeer("@username")`。
2. 有手机号：`await telegram.meetPeer("+8613800000000", { kind: "phone" })`。
3. 是已有对话：`await telegram.findDialogs(userIdOrUsername, { limit: 200 })`。
4. 手里有该用户发来的消息：`await telegram.meetPeer(userId, { chatId, messageIds: [messageId] })`。

## 示例

```ts
try {
  await telegram.sendText(userId, "你好");
} catch (err) {
  console.log(String(err));
  await telegram.meetPeer(userId, { chatId, messageIds: [messageId] });
  await telegram.sendText(userId, "你好");
}
```

## 注意

- 不要反复用同一个裸数字 user id 重试。
- `findDialogs` 只适合当前账号已有对话的对象。
- 解析成功后，后续发送/读取通常就能直接使用原始 peer。

