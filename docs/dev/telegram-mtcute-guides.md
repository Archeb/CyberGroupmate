# Telegram mtcute Guides

本文档记录 Telegram 内置 guide 的维护方式，尤其是从 mtcute 类型声明自动生成的那部分。

## 设计目标

Telegram / MTProto 能力很大，不适合把所有 API 都常驻放进 Agent 的 brief。项目把低频、流程型、成组使用的能力收束成 `telegram.useXxx()` guide 入口。`useXxx()` 本身不会执行实际平台操作，只会触发 Pass 2 注入完整说明；真正执行时，Agent 直接调用 guide 中披露的 `telegram.<method>(...)`。

例子：

```ts
telegram.useInlineBot();
telegram.useStories();
telegram.useAccountProfile();
telegram.useChatAdministration();
```

`downloadMedia()`、`forwardMessage()` 这类单步语义函数仍然常驻暴露，不需要 guide。

## 暴露边界

Telegram guide 的目标不是把 mtcute 全量映射出来，而是让 Agent 像普通人类用户一样完成常见通信、资料、群管理和内容发布任务。

默认保留：

- 个人资料：bio、姓名、用户名、头像、生日、emoji status、close friends。
- 消息流程：回复、评论、引用、复制、定时消息、网页预览、reaction 用户查询。单步转发使用常驻 `telegram.forwardMessage()`。
- 群/频道管理：建群建频道、资料、权限、成员限制、管理员、事件日志。
- 邀请链接、论坛话题、Stories、投票/Todo、inline bot。

默认不暴露：

- 通讯录和联系人管理。
- Telegram Business 配置。
- bot 管理、WebApp 回调、game score、commands、menu button 等 bot 侧能力。
- 账号安全/2FA/恢复流程。
- Stars/Gifts/Boosts 等付费或资产能力。
- 贴纸包维护和 custom emoji 管理；发送贴纸仍使用常驻 `sendSticker()`。
- 客户端 UI 整理类能力，例如聊天文件夹和归档。
- Telegram 内置翻译；Agent 自己可以用语言模型完成翻译。
- 大范围删除历史、转移群主、删除群/频道等高风险破坏性操作。

## 关键文件

- `src/core/telegram-mtcute-passthrough.ts`
  - `TELEGRAM_MTCUTE_GUIDE_METHODS`：按 guide 分组列出允许转发的 mtcute high-level methods。
  - `TELEGRAM_MTCUTE_WRITE_METHODS`：会改变 Telegram 状态的写方法集合。
  - `getTelegramMtcuteWriteTarget()`：从写方法参数中提取目标 chat，用于绑定聊天写限制。
- `src/tools/generate-telegram-mtcute-guides.ts`
  - 从本地 `node_modules/@mtcute/core/highlevel/client.d.ts` 抽取真实 TypeScript 签名、JSDoc、参数注释和相关类型声明。
  - `GUIDE_META` 存放生成 guide 的中文说明、使用要点和少量项目特有补充。
- `src/sandbox/builtin-guides/telegram/`
  - `AUTO-GENERATED` 开头的 `use*.md` 是生成物，不要手改。
  - `useInlineBot.md`、`usePeerResolution.md`、`useMessageSearch.md` 是项目手写 guide。
- `src/sandbox/builtin-guides.ts`
  - 注册 `useXxx()` guide，并提供 Pass 1 brief。
- `src/sandbox/modules/telegram/telegram.d.ts`
  - 暴露给 Agent 的 Telegram brief 类型定义。
- `src/sandbox/modules/telegram/index.ts`
  - `useXxx()` activator 和 generic mtcute passthrough proxy。
- `src/adapter/telegram-adapter.ts`
  - `telegram.mtcute` host call 会按 allowlist 把方法和参数转发给当前 mtcute client。
  - 像 `telegram.forwardMessage()` 这种一行就能完成用户意图的封装保留为顶层 host call。

## 更新 guide 说明

如果只是更新生成 guide 里的中文说明、使用要点或分组介绍：

1. 修改 `src/tools/generate-telegram-mtcute-guides.ts` 里的 `GUIDE_META`。
2. 运行：

```bash
npm run gen:telegram-mtcute-guides
```

3. 检查 `src/sandbox/builtin-guides/telegram/` 里的生成 diff。生成脚本会删除已经不在 `GUIDE_META` 中的旧 `AUTO-GENERATED` guide 文件。

如果改的是 Pass 1 能看到的一两句 brief，还需要同步：

1. 更新 `src/sandbox/builtin-guides.ts` 中对应 guide 的 `brief`。
2. 更新 `src/sandbox/modules/telegram/telegram.d.ts` 中对应 `useXxx()` 的 JSDoc。
3. 运行：

```bash
npm run gen:module-docs
```

## 更新手写 guide

以下 guide 不是 mtcute `.d.ts` 生成物，可以直接编辑 markdown：

- `src/sandbox/builtin-guides/telegram/useInlineBot.md`
- `src/sandbox/builtin-guides/telegram/usePeerResolution.md`
- `src/sandbox/builtin-guides/telegram/useMessageSearch.md`

这些文档包含项目 adapter 自己封装的流程，或者 peer 排障这种框架级说明，不从 mtcute reference 自动生成。

## 升级 mtcute 或新增方法

如果 mtcute 升级后出现了新方法，或要把已有 mtcute high-level method 暴露给 Agent：

1. 更新依赖并安装，让本地 `.d.ts` 代表真实运行时版本。

```bash
npm install @mtcute/node@latest
```

2. 在 `src/core/telegram-mtcute-passthrough.ts` 的 `TELEGRAM_MTCUTE_GUIDE_METHODS` 中把方法名放进合适分组。
3. 如果方法会改变 Telegram 状态，把方法名加入 `TELEGRAM_MTCUTE_WRITE_METHODS`。
4. 如果写方法作用于某个 chat，在 `getTelegramMtcuteWriteTarget()` 中补目标 chat 提取逻辑，保证绑定聊天的写限制仍然生效。
5. 运行：

```bash
npm run gen:telegram-mtcute-guides
```

如果脚本报 `method not present on the local TelegramClient type`，说明当前安装的 mtcute 版本还没有这个方法。不要只凭在线 reference 把它暴露给 Agent。

如果某个能力已经是一条清晰的单步语义，例如「转发这条消息」而不是一整套流程，优先做成顶层方法：在 `telegram.d.ts` 写 brief 和类型，在 `telegram/index.ts` 里转发 host call，在 `TelegramAdapter.getWriteMethods()`/`handleCall()` 里实现，并运行 `npm run gen:module-docs`。这类方法不应该同时留在 mtcute guide allowlist 里。

## 新增 guide 分类

如果新增全新的 `telegram.useXxx()` 分类，需要同步修改：

1. `src/core/telegram-mtcute-passthrough.ts`：新增 `TELEGRAM_MTCUTE_GUIDE_METHODS` 分组。
2. `src/tools/generate-telegram-mtcute-guides.ts`：新增 `GUIDE_META`。
3. `src/sandbox/builtin-guides.ts`：注册 guide 文件、方法名和 Pass 1 brief。
4. `src/sandbox/modules/telegram/telegram.d.ts`：新增 `useXxx(): Promise<string>` 和 JSDoc。
5. `src/sandbox/modules/telegram/index.ts`：新增 activator。
6. `tests/telegram-guides.test.ts`：按需补 brief、Pass 2 注入或关键签名测试。
7. 运行生成命令和测试。

## 只同步 mtcute 类型/JSDoc 变化

如果 mtcute 的 JSDoc 或类型声明变了，但方法分组不变：

1. 更新 mtcute 依赖。
2. 运行 `npm run gen:telegram-mtcute-guides`。
3. 检查生成 diff，确认签名和引用类型变化符合预期。

## 验证命令

推荐最小验证：

```bash
npm run gen:telegram-mtcute-guides
npm run gen:module-docs
npx tsc --noEmit
npx tsx --test tests/telegram-guides.test.ts tests/platform-dedup.test.ts tests/sandbox-two-pass.test.ts
```

全量 `npm test` 可作为最后检查。如果仓库存在既有失败，在提交说明里区分本次相关测试和既有失败。
