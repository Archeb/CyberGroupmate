# Sandbox API Brief Overview

## actions
* shared/actions.d.ts — 所有 scene 共享的 actions 能力

- `getTopicContext`: 获取某个话题的结构化上下文
- `listActiveTopics`: 列出当前活跃话题
- `recallForTopic`: 以话题为中心触发一次记忆检索

## ctx.discord
discord.d.ts — Discord 场景类型定义

- `sendText`: 发送文本消息到指定频道。
- `sendMedia`: 发送媒体消息（附件）到指定频道。
- `sendTyping`: 在频道中显示 "正在输入..." 状态。

## docs
docs.d.ts — 文档查阅系统类型定义

- `list`: 列出所有可用文档（返回 slug 和标题）
- `read`: 读取指定文档的完整内容

## memory
memory.d.ts — Memory V2 Agent API 类型定义

- `recall`: 统一记忆检索入口
- `browseHistory`: 消息档案检索
- `reflect`: 对指定群组进行反思总结

## runtime
* shared/runtime.d.ts — 所有 scene 共享的 runtime 能力

- `notify`: 推送事件到通知中心
- `input`: 请求用户输入
- `print`: 直接打印到宿主
- `spawn`: 启动一个命名后台任务
- `kill`: 停止一个后台任务
- `ps`: 列出后台任务

## scene
shared/scene.d.ts — 所有 scene 共享的场景信息能力

- `list`: 列出所有可用场景及简介
- `showFullTypes`: 展示当前场景的完整类型定义（L2）

## skills
* shared/skills.d.ts — 所有 scene 共享的代码型 skills 能力

- `recallAndSummarize`: recallAndSummarize(query: string, options?: Record<string, unknown>): Promise<unknown>
- `browseForAnswer`: browseForAnswer(request: Record<string, unknown>): Promise<unknown>

## web
tavily.d.ts — 网络搜索模块类型定义

- `search`: 搜索网页内容。
- `extract`: 从指定 URL 提取页面内容。

## ctx.tg
telegram.d.ts — Telegram 场景类型定义

- `sendText`: sendText(chatId: number | string, text: string, opts?: { replyTo?: number }): Promise<Message>
- `sendMedia`: 发送媒体消息。支持 URL 和本地文件路径。
- `sendFile`: 发送磁盘文件到聊天（通过绝对路径）。host 侧读取文件并上传。始终作为文件/文档发送。
- `sendSticker`: 发送贴纸。通过 uniqueFileId 引用本地已缓存的贴纸文件。
- `getMe`: getMe(): Promise<User>
- `getChat`: getChat(chatId: number | string): Promise<Chat>
- `getUser`: getUser(userId: number | string): Promise<User>
- `getDialogs`: 获取最近的对话列表（包含 peer、最后一条消息、未读数）
- `getChatMembers`: getChatMembers(chatId: number | string, opts?: { limit?: number }): Promise<Peer[]>
- `getHistory`: getHistory(chatId: number | string, opts?: { limit?: number }): Promise<Message[]>
- `iterHistory`: iterHistory(chatId: number | string, opts?: { limit?: number }): AsyncIterable<Message>
- `iterDialogs`: iterDialogs(opts?: { limit?: number }): AsyncIterable<Dialog>
- `joinChat`: 加入一个群聊或频道
- `leaveChat`: 退出一个群聊或频道
- `readHistory`: readHistory(chatId: number | string): Promise<void>
- `sendTyping`: sendTyping(chatId: number | string): Promise<void>

## github
github.d.ts — GitHub Skill 类型定义（示例 TS Skill）

- `listIssues`: 列出仓库的 Issue
- `createIssue`: 创建新 Issue
- `getRepo`: 获取仓库信息
