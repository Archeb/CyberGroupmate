## 什么时候使用

当需要主动拉取视野外上下文、爬楼、搜索历史消息，或用异步迭代器遍历历史时，先阅读本指南。

## 可用 API

```ts
telegram.getMessages(chatId: string | number, messageIds: number[]): Promise<Array<TelegramMessage | null>>;

telegram.getHistory(chatId: string | number, opts?: { limit?: number }): Promise<TelegramMessage[]>;

telegram.searchMessages(
  chatId: string | number,
  query: string,
  opts?: { limit?: number }
): Promise<TelegramMessage[]>;

telegram.iterHistory(chatId: string | number, opts?: { limit?: number }): AsyncIterable<TelegramMessage>;
telegram.iterDialogs(opts?: { limit?: number }): AsyncIterable<Dialog>;
```

## 常见流程

精确爬楼：

```ts
const around = await telegram.getMessages(chatId, [messageId - 2, messageId - 1, messageId]);
console.log(JSON.stringify(around, null, 2));
```

关键词搜索：

```ts
const results = await telegram.searchMessages(chatId, "关键词", { limit: 20 });
console.log(JSON.stringify(results, null, 2));
```

流式遍历：

```ts
const picked = [];
for await (const msg of telegram.iterHistory(chatId, { limit: 100 })) {
  if (msg.text.includes("关键词")) picked.push(msg);
}
console.log(JSON.stringify(picked, null, 2));
```

## 注意

- 先取少量消息确认结构，再扩大 limit。
- bot mode 可能不能读取历史；userbot mode 更适合主动检索。
- 不要无目的拉取大量历史。

