# Sandbox API Brief Overview

## cron
shared/cron.d.ts — 定时任务管理模块类型定义 通过 Host 侧 GlobalState 持久化 cron 任务。 触发时以自然语言任务描述唤醒 agent，由 agent 自主决策执行。

- `add`: 添加持久化定时任务。触发时以自然语言任务描述唤醒 agent，agent 在当时的上下文中自主决定如何执行。 ⚠️ taskDescription 必须是详细的自然语言描述，不是代码。 写清楚：要做什么、给谁发、发什么内容、从哪里获取信息等。 agent 会在每次触发时收到这段描述作为新任务。 限制：最短间隔 1 小时，每个群最多 10 个 cron 任务。 一次性定时任务请使用 runtime.remind
- `remove`: 移除定时任务
- `list`: 列出当前 chat 的所有定时任务

## discord
discord.d.ts — Discord 平台 API 系统注入的 Discord host proxy 接口。 提供给 Agent 在 sandbox 执行时作为 TypeScript 强类型上下文参考。 平台连接与消息监听由宿主侧 DiscordAdapter 管理。

- `sendText`: 发送文本消息到指定频道。
- `sendMedia`: 发送媒体消息（附件）到指定频道。支持 URL 和本地文件路径（支持绝对路径或基于 cwd 工作区的相对路径）。
- `sendTyping`: 在频道中显示 "正在输入..." 状态。

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

## todo
shared/todo.d.ts — 不只是代办，可以当你的记事本用。 用于持久化当前群的待办、规则和长期约定（比如群规、话语风格、被教导的/发现的事实性记忆）。 数据按群隔离，可选设置到期时间。“定期、到期提醒”类请使用 remind 或者 cron 模块。

- `list`: 列出当前群的 todo。
- `get`: 获取单个 todo。
- `upsert`: 新增或更新 todo。
- `remove`: 删除 todo。

## mcp
mcp-bridge.d.ts — MCP Server 连接器类型定义 连接外部 MCP (Model Context Protocol) Server，自动发现并代理其工具。 支持 stdio 和 Streamable HTTP 两种传输。

- `connect`: 连接到一个 MCP Server。 根据配置使用 stdio 或 Streamable HTTP 建立连接，自动发现所有 tools。
- `disconnect`: 断开连接并清理 MCP Server 子进程
- `list`: 列出所有已连接的 MCP Servers 及其工具
- `call`: 直接调用指定 server 的 tool（无需先调用 connect 返回的代理对象）

## onebot
onebot.d.ts — QQ / OneBot 平台 API 系统注入的 OneBot host proxy 接口。 也会以 `qq` 别名暴露给 sandbox。

- `sendText`: 发送文本消息。
- `sendMedia`: 发送媒体消息。支持本地文件路径或 URL。
- `sendFile`: 发送文件。
- `sendSticker`: 发送贴纸或图片表情。
- `sendFace`: 发送 QQ 系统表情（CQ face）。
- `sendTyping`: OneBot 无 typing 指示，此方法为 no-op。
- `deleteMessages`: 撤回消息。
- `downloadMedia`: 下载媒体到本地 workspace/Downloads/。

## runtime
shared/runtime.d.ts — 系统级能力

- `notify`: 推送事件到通知中心
- `input`: 请求host用户输入
- `print`: 直接打印到host
- `spawn`: 启动一个命名后台任务
- `spawnPersistent`: 启动持久化后台任务（Worker 重启后自动恢复）。 代码以字符串形式存储，触发时在 sandbox 中执行。 代码中可通过 `signal` 变量访问 AbortSignal。
- `kill`: 停止一个后台任务（同时清除持久化记录）
- `ps`: 列出后台任务
- `home`: 返回当前 sandbox 的 home 目录路径（per-chat 隔离）
- `workspace`: 返回 workspace 根目录路径
- `env.list`: 列出所有受管环境变量
- `env.get`: 查询单个环境变量，不存在返回 null
- `env.set`: 新增或覆盖环境变量。
- `env.delete`: 删除环境变量（不存在时安全返回）
- `remind`: 设置一次性定时提醒（自然语言）。到期后 agent 将被唤醒并收到 description 作为新任务。重复定时提醒请用 cron ⚠️ description 必须是详细的自然语言描述，不是代码。 写清楚：要做什么、给谁发、发什么内容、如何获取信息等。 限制：最短 1 分钟，最长 365 天，每个群最多 10 个活跃提醒。
- `extendSteps`: 增加当前 CodeAct session 的可用轮次。 仅对当前 session（本轮任务）生效，不会持久化到下次任务。 在本轮代码中调用后，从下一轮开始生效。
- `modifyTimeout`: 修改当前 CodeAct session 后续代码执行超时（毫秒）。 仅对当前 session（本轮任务）生效，不会持久化到下次任务。 在本轮代码中调用后，从下一段代码执行开始生效。

## shell
shell.d.ts — 终端 Tab 管理模块 提供类似 tmux/terminal tabs 的多终端管理能力。 主终端 "default" 是所有 ```bash``` 代码块的执行目标。 当主终端被长时间运行的服务阻塞时，可以将其 detach 到后台并获得全新主终端。

- `listTabs`: 列出所有存活的终端 Tab 及其状态。
- `detach`: 分离当前主终端到后台，并立刻获得一个全新的 default 终端。 当主终端被长时间运行的命令（如 `npm run dev`）阻塞时： 1. 当前 default 终端被重命名为 newTabId 并移入后台 2. 系统自动创建全新的 default 终端 3. 后续 ```bash``` 代码块将在新终端中执行
- `read`: 读取指定终端的输出历史。 用于排查超时命令的残留输出，或查看后台服务日志。 默认读取 default 终端，可指定 tabId 读取后台终端。
- `sendInput`: 向指定终端注入按键输入。 用于应对交互式 CLI 的确认提示（如 "Is this ok? (y/N)"）。 也可发送 Ctrl+C（"\x03"）来优雅地中断进程。
- `kill`: 销毁指定终端中的所有进程并回收该 tab。 如果销毁的是 default 终端，会自动创建新的 default。
- `cwd`: 获取当前主终端的工作目录。

## skills
shared/skills.d.ts — Skills 高层能力 + 管理接口

- `install`: 安装或创建一个新 Skill。支持SKILL.md 型（多数场景）和TS Skills（复杂能力场景） 两种方式完成文件后，都需要调用 skills.reload() 生效。
- `list`: 列出当前已加载的 Skills 名称
- `reload`: 热重载所有 Skills。在 workspace/skills/ 下创建/修改文件后调用。
- `npmInstall`: 安装 npm 包到 workspace/skills/ 目录

## telegram
telegram.d.ts — Telegram 平台 API 这是系统注入的 Telegram host proxy 的接口子集。 提供给 Agent 在 sandbox 执行时作为 TypeScript 强类型上下文参考。 平台连接与消息监听由宿主侧官方 adapter 管理。

- `sendText`: 发送普通文本消息
- `sendMedia`: 发送媒体消息。支持 URL 和本地文件路径（支持绝对路径或基于 cwd 工作区的相对路径）。
- `sendFile`: 发送磁盘文件到聊天。支持绝对路径或基于 cwd 的相对路径。host 侧读取文件并上传。始终作为文件/文档发送。
- `sendSticker`: 发送贴纸。通过 uniqueFileId 引用本地已缓存的贴纸文件。
- `sendMediaGroup`: 发送媒体相册（多张图片/视频合并为一组）。 第一个媒体项的 caption 将作为整组的文案。
- `sendPoll`: 发起投票或测验。
- `sendReaction`: 对消息发送表情表态。传 null 以撤销表态。
- `editMessage`: 编辑已发送的消息文本。
- `deleteMessages`: 删除一条或多条消息。
- `pinMessage`: 置顶一条消息
- `unpinMessage`: 取消置顶一条消息
- `getMe`: 获取当前登录机器人的基础信息
- `getChat`: 精确获取指定会话的基础信息
- `getUser`: 精确获取指定用户的基础信息
- `getDialogs`: 获取最近的对话列表（包含 peer、最后一条消息、未读数）
- `getFullUser`: 获取用户的完整资料（包含个人简介 bio 等）。
- `getFullChat`: 获取群组/频道的完整资料（包含群描述 about、成员数等）。
- `getChatMembers`: 分页拉取群组成员列表
- `getHistory`: 拉取指定会话的历史消息（一次性返回列表）
- `getMessages`: 按消息 ID 精确获取一条或多条消息。（在别人回复或者提及某消息但是你看不见的时候，善用该函数爬楼获取上下文）
- `searchMessages`: 在群组内搜索消息。（可主动利用该函数获取视野外上下文信息）
- `getForumTopics`: 获取指定群组的论坛板块（话题）列表。要求该群组已开启 Forum 模式。
- `getPollResults`: 主动拉取某条投票消息的最新计票结果。
- `getMessageReactions`: 主动拉取某条消息的表态（Reaction）汇总数据。
- `downloadMedia`: 下载媒体文件的二进制数据。返回 base64 编码的 buffer 和文件大小。 需要传入通过 mediaInfo.fileId 获取的文件标识符。
- `iterHistory`: 以异步迭代器方式遍历历史消息，用于深入流式检索
- `iterDialogs`: 以异步迭代器方式遍历最近的对话列表
- `joinChat`: 加入一个群聊或频道
- `leaveChat`: 退出一个群聊或频道
- `readHistory`: 将指定会话的所有未读消息标记为已读
- `sendTyping`: 触发短暂的 `Typing` 正在输入反馈状态

## vision
modules/vision.d.ts — Vision 视觉模块类型定义 提供图片识别能力，让 Agent 可以"看到"图片并理解其内容。 图片路径限定在 workspace/ 目录下。 vision: VisionModule — 全局可用

- `see`: 看图：读取一张或多张图片文件，返回每张图片的文字描述。 使用 Vision LLM 分析图片内容，支持 JPEG、PNG、WebP 等常见格式。
