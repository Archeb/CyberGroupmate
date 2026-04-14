# Sandbox API Brief Overview

## actions
shared/actions.d.ts — 所有 scene 共享的 actions 能力

- `getTopicContext`: 获取某个话题的结构化上下文
- `listActiveTopics`: 列出当前活跃话题
- `recallForTopic`: 以话题为中心触发一次记忆检索

## discord
discord.d.ts — Discord 平台 API 系统注入的 Discord host proxy 接口。 提供给 Agent 在 sandbox 执行时作为 TypeScript 强类型上下文参考。 平台连接与消息监听由宿主侧 DiscordAdapter 管理。

- `sendText`: 发送文本消息到指定频道。
- `sendMedia`: 发送媒体消息（附件）到指定频道。
- `sendTyping`: 在频道中显示 "正在输入..." 状态。

## docs
docs.d.ts — 文档查阅系统类型定义 Agent 可通过 docs 对象查阅 workspace/agent-docs/ 下的 markdown 文档。 文档在 worker 启动时加载，支持精确匹配和模糊匹配。

- `list`: 列出所有可用文档（返回 slug、标题，以及是否为标准 Agent Skill）
- `read`: 读取指定文档的完整内容 支持精确 slug 匹配和模糊匹配

## memory
memory.d.ts — Memory V2 Agent API 类型定义 记忆系统 V2 接口。Agent 可通过 memory 全局对象使用： - recall()：统一记忆检索（向量 + 关键词混合搜索） - browseHistory()：消息档案检索（LLM 深度阅读） - reflect()：触发群组反思总结 注意：记忆的写入由后台 Pipeline 自动完成（RecordingPipeline + post-session fact extraction），Agent 不需要手动写入。 memory: MemoryStore — 全局可用

- `recall`: 统一记忆检索入口 使用向量搜索 + 关键词搜索混合检索
- `browseHistory`: 消息档案检索 话题索引引导 + 模糊搜索 + cheap model 深度阅读
- `reflect`: 对指定群组进行反思总结 读取上次反思以来的 topics 和 interactions，生成结构化总结

## runtime
shared/runtime.d.ts — 所有 scene 共享的 runtime 能力

- `notify`: 推送事件到通知中心
- `input`: 请求用户输入
- `print`: 直接打印到宿主
- `spawn`: 启动一个命名后台任务
- `spawnPersistent`: 启动持久化后台任务（Worker 重启后自动恢复）。 代码以字符串形式存储，触发时在 sandbox 中执行。 代码中可通过 `signal` 变量访问 AbortSignal。
- `kill`: 停止一个后台任务（同时清除持久化记录）
- `ps`: 列出后台任务
- `home`: 返回当前 sandbox 的 home 目录路径（per-chat 隔离）
- `workspace`: 返回 workspace 根目录路径
- `remind`: 设置一次性定时提醒（自然语言）。到期后 agent 将被唤醒并收到 description 作为新任务。重复定时提醒请用 cron ⚠️ description 必须是详细的自然语言描述，不是代码。 写清楚：要做什么、给谁发、发什么内容、如何获取信息等。 限制：最短 1 分钟，最长 365 天，每个群最多 10 个活跃提醒。

## scene
shared/scene.d.ts — 所有 scene 共享的场景信息能力 agent 不再主动切换场景，框架根据角色自动注入对应的 API。

- `current`: 当前所在场景名称（框架自动设置）
- `list`: 列出所有可用场景及简介
- `showFullTypes`: 展示当前场景的完整类型定义（L2）

## skills
shared/skills.d.ts — Skills 高层能力 + 管理接口

- `memory.recallAndSummarize`: recallAndSummarize(query: string, options?: Record<string, unknown>): Promise<unknown>
- `memory.browseForAnswer`: browseForAnswer(request: Record<string, unknown>): Promise<unknown>
- `list`: 列出当前已加载的 Skills 名称
- `reload`: 热重载所有 Skills。在 workspace/skills/ 下创建/修改文件后调用。
- `npmInstall`: 安装 npm 包到 workspace/skills/ 目录

## telegram
telegram.d.ts — Telegram 平台 API 这是系统注入的 Telegram host proxy 的接口子集。 提供给 Agent 在 sandbox 执行时作为 TypeScript 强类型上下文参考。 平台连接与消息监听由宿主侧官方 adapter 管理。

- `sendText`: sendText(chatId: number | string, text: string, opts?: SendMessageOptions): Promise<Message>
- `sendMedia`: 发送媒体消息。支持 URL 和本地文件路径。
- `sendFile`: 发送磁盘文件到聊天（通过绝对路径）。host 侧读取文件并上传。始终作为文件/文档发送。
- `sendSticker`: 发送贴纸。通过 uniqueFileId 引用本地已缓存的贴纸文件。
- `sendMediaGroup`: 发送媒体相册（多张图片/视频合并为一组）。 第一个媒体项的 caption 将作为整组的文案。
- `sendPoll`: 发起投票或测验。
- `sendReaction`: 对消息发送表情表态。传 null 以撤销表态。
- `editMessage`: 编辑已发送的消息文本。
- `deleteMessages`: 删除一条或多条消息。
- `pinMessage`: 置顶一条消息
- `unpinMessage`: 取消置顶一条消息
- `getMe`: getMe(): Promise<User>
- `getChat`: getChat(chatId: number | string): Promise<Chat>
- `getUser`: getUser(userId: number | string): Promise<User>
- `getDialogs`: 获取最近的对话列表（包含 peer、最后一条消息、未读数）
- `getFullUser`: 获取用户的完整资料（包含个人简介 bio 等）。
- `getFullChat`: 获取群组/频道的完整资料（包含群描述 about、成员数等）。
- `getChatMembers`: getChatMembers(chatId: number | string, opts?: { limit?: number }): Promise<Peer[]>
- `getHistory`: getHistory(chatId: number | string, opts?: { limit?: number }): Promise<Message[]>
- `getMessages`: 按消息 ID 精确获取一条或多条消息。（在别人回复或者提及某消息但是你看不见的时候，善用该函数爬楼获取上下文）
- `searchMessages`: 在群组内搜索消息。（可主动利用该函数获取视野外上下文信息）
- `getForumTopics`: 获取指定群组的论坛板块（话题）列表。要求该群组已开启 Forum 模式。
- `getPollResults`: 主动拉取某条投票消息的最新计票结果。
- `getMessageReactions`: 主动拉取某条消息的表态（Reaction）汇总数据。
- `downloadMedia`: 下载媒体文件的二进制数据。返回 base64 编码的 buffer 和文件大小。 需要传入通过 mediaInfo.fileId 获取的文件标识符。
- `iterHistory`: iterHistory(chatId: number | string, opts?: { limit?: number }): AsyncIterable<Message>
- `iterDialogs`: iterDialogs(opts?: { limit?: number }): AsyncIterable<Dialog>
- `joinChat`: 加入一个群聊或频道
- `leaveChat`: 退出一个群聊或频道
- `readHistory`: readHistory(chatId: number | string): Promise<void>
- `sendTyping`: sendTyping(chatId: number | string): Promise<void>

## cron
shared/cron.d.ts — 定时任务管理模块类型定义 通过 Host 侧 GlobalState 持久化 cron 任务。 触发时以自然语言任务描述唤醒 agent，由 agent 自主决策执行。

- `add`: 添加持久化定时任务。触发时以自然语言任务描述唤醒 agent，agent 在当时的上下文中自主决定如何执行。 ⚠️ taskDescription 必须是详细的自然语言描述，不是代码。 写清楚：要做什么、给谁发、发什么内容、从哪里获取信息等。 agent 会在每次触发时收到这段描述作为新任务。 限制：最短间隔 1 小时，每个群最多 10 个 cron 任务。 一次性定时任务请使用 runtime.remind
- `remove`: 移除定时任务
- `list`: 列出当前 chat 的所有定时任务

## events
shared/events.d.ts — 事件监听器模块类型定义 注册事件监听器，当匹配的事件到达时在 sandbox 中执行处理代码。 监听器持久化到磁盘，Worker 重启后自动恢复。

- `on`: 注册事件监听器。匹配 type 前缀的事件会触发 handlerCode 在 sandbox 中执行。 handler 代码中可通过 `event` 变量访问事件数据。
- `off`: 移除监听器
- `list`: 列出当前所有监听器

## fs
filesystem.d.ts — 文件系统操作模块类型定义 所有路径操作限定在 workspace/ 目录下。 支持相对路径（相对于 workspace/）和绝对路径。

- `readFile`: 读取文件内容。
- `writeFile`: 写入文件。如果目标目录不存在会自动创建。
- `appendFile`: 追加写入文件。文件不存在时会自动创建。
- `readdir`: 列出目录下的文件和子目录名。
- `exists`: 检查文件或目录是否存在。
- `unlink`: 删除文件。
- `mkdir`: 创建目录（递归创建，类似 mkdir -p）。
- `stat`: 获取文件或目录的状态信息。

## http
shared/http.d.ts — HTTP Webhook 模块类型定义 注册 HTTP webhook 端点，外部系统通过 HTTP POST 触发 sandbox 代码执行。 Webhook 持久化到磁盘，Worker 重启后自动恢复。

- `onWebhook`: 注册 webhook 端点。 外部可通过 POST /webhook/{path} 触发 handler 代码执行。 handler 代码中可通过 `request` 变量访问请求数据。
- `removeWebhook`: 移除 webhook
- `listWebhooks`: 列出当前所有 webhook

## kv
shared/kv.d.ts — 持久化键值存储模块类型定义 简单的 per-chat 键值存储，数据持久化到 SQLite。 比 ctx 更正式的存储方式，支持 TTL 过期。

- `get`: 读取键值
- `set`: 写入键值
- `del`: 删除键
- `keys`: 列出键名（可按前缀过滤）

## mcp
mcp-bridge.d.ts — MCP Server 连接器类型定义 连接外部 MCP (Model Context Protocol) Server，自动发现并代理其工具。 支持 stdio 和 Streamable HTTP 两种传输。

- `connect`: 连接到一个 MCP Server。 根据配置使用 stdio 或 Streamable HTTP 建立连接，自动发现所有 tools。
- `disconnect`: 断开连接并清理 MCP Server 子进程
- `list`: 列出所有已连接的 MCP Servers 及其工具
- `call`: 直接调用指定 server 的 tool（无需先调用 connect 返回的代理对象）
