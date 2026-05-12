## 什么时候使用

当任务需要像 Telegram 客户端里输入 `@bot query` 那样查询 inline bot，并把某个 inline result 发送到聊天里时，先阅读本指南。

不要把 inline bot 和“处理别人发来的 inline query”混在一起：这里是作为 userbot/客户端去使用别人的 inline bot。

## 可用 API

```ts
telegram.queryInlineBot(
  bot: string | number,
  query: string,
  opts?: {
    peer?: string | number;
    offset?: string;
  }
): Promise<{
  queryId: string;
  nextOffset?: string;
  results: Array<{
    id: string;
    type?: string;
    title?: string;
    description?: string;
    sendMessage?: unknown;
    raw?: unknown;
  }>;
  raw?: unknown;
}>;

telegram.sendInlineBotResult(
  chatId: string | number,
  queryId: string | number,
  resultId: string,
  opts?: {
    replyTo?: number;
    silent?: boolean;
    hideVia?: boolean;
    clearDraft?: boolean;
  }
): Promise<unknown>;
```

## 推荐流程

1. 用 `telegram.queryInlineBot(bot, query, { peer: chatId })` 查询结果。
2. `console.log(JSON.stringify(results, null, 2))` 看清楚候选项，不要盲发第一个。
3. 选择 `results[i].id`。
4. 用 `telegram.sendInlineBotResult(chatId, queryId, resultId, opts)` 发送。

## 示例

```ts
const found = await telegram.queryInlineBot("@gif", "happy cat", { peer: chatId });
console.log(JSON.stringify(found.results.slice(0, 5), null, 2));

const choice = found.results[0];
if (!choice) {
  await telegram.sendText(chatId, "没搜到合适的结果。");
} else {
  await telegram.sendInlineBotResult(chatId, found.queryId, choice.id, { replyTo: messageId });
}
```

## 注意

- `peer` 应该传将要发送到的聊天；Telegram 会把它当作“当前打开的聊天”参与 inline bot 查询。
- 如果 bot 或目标聊天 peer 解析失败，先用 `telegram.usePeerResolution()` 里的方法预热。
- 发送前必须检查结果。inline bot 的第一个结果不一定符合用户意图。

