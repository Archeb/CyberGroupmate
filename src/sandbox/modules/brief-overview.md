# Sandbox API Brief Overview

## actions
shared/actions.d.ts — 所有 scene 共享的 actions 能力

- `getTopicContext`: 获取某个话题的结构化上下文
- `listActiveTopics`: 列出当前活跃话题
- `recallForTopic`: 以话题为中心触发一次记忆检索

## ctx
discord.d.ts — Discord 场景类型定义

- `discord.sendText`: 发送文本消息到指定频道。
- `discord.sendMedia`: 发送媒体消息（附件）到指定频道。
- `discord.sendTyping`: 在频道中显示 "正在输入..." 状态。
- `tg.sendText`: sendText(chatId: number | string, text: string, opts?: SendMessageOptions): Promise<Message>
- `tg.sendMedia`: 发送媒体消息。支持 URL 和本地文件路径。
- `tg.sendFile`: 发送磁盘文件到聊天（通过绝对路径）。host 侧读取文件并上传。始终作为文件/文档发送。
- `tg.sendSticker`: 发送贴纸。通过 uniqueFileId 引用本地已缓存的贴纸文件。
- `tg.sendMediaGroup`: 发送媒体相册（多张图片/视频合并为一组）。
- `tg.sendPoll`: 发起投票或测验。
- `tg.sendReaction`: 对消息发送表情表态。传 null 以撤销表态。
- `tg.editMessage`: 编辑已发送的消息文本。
- `tg.deleteMessages`: 删除一条或多条消息。
- `tg.pinMessage`: 置顶一条消息
- `tg.unpinMessage`: 取消置顶一条消息
- `tg.getMe`: getMe(): Promise<User>
- `tg.getChat`: getChat(chatId: number | string): Promise<Chat>
- `tg.getUser`: getUser(userId: number | string): Promise<User>
- `tg.getDialogs`: 获取最近的对话列表（包含 peer、最后一条消息、未读数）
- `tg.getFullUser`: 获取用户的完整资料（包含个人简介 bio 等）。
- `tg.getFullChat`: 获取群组/频道的完整资料（包含群描述 about、成员数等）。
- `tg.getChatMembers`: getChatMembers(chatId: number | string, opts?: { limit?: number }): Promise<Peer[]>
- `tg.getHistory`: getHistory(chatId: number | string, opts?: { limit?: number }): Promise<Message[]>
- `tg.getMessages`: 按消息 ID 精确获取一条或多条消息。
- `tg.searchMessages`: 在群组内搜索消息。
- `tg.getForumTopics`: 获取指定群组的论坛板块（话题）列表。要求该群组已开启 Forum 模式。
- `tg.getPollResults`: 主动拉取某条投票消息的最新计票结果。
- `tg.getMessageReactions`: 主动拉取某条消息的表态（Reaction）汇总数据。
- `tg.downloadMedia`: 下载媒体文件的二进制数据。返回 base64 编码的 buffer 和文件大小。
- `tg.iterHistory`: iterHistory(chatId: number | string, opts?: { limit?: number }): AsyncIterable<Message>
- `tg.iterDialogs`: iterDialogs(opts?: { limit?: number }): AsyncIterable<Dialog>
- `tg.joinChat`: 加入一个群聊或频道
- `tg.leaveChat`: 退出一个群聊或频道
- `tg.readHistory`: readHistory(chatId: number | string): Promise<void>
- `tg.sendTyping`: sendTyping(chatId: number | string): Promise<void>

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
shared/runtime.d.ts — 所有 scene 共享的 runtime 能力

- `notify`: 推送事件到通知中心
- `input`: 请求用户输入
- `print`: 直接打印到宿主
- `spawn`: 启动一个命名后台任务
- `kill`: 停止一个后台任务
- `ps`: 列出后台任务

## scene
shared/scene.d.ts — 所有 scene 共享的场景信息能力

- `current`: 当前所在场景名称（框架自动设置）
- `list`: 列出所有可用场景及简介
- `showFullTypes`: 展示当前场景的完整类型定义（L2）

## skills
shared/skills.d.ts — 所有 scene 共享的代码型 skills 能力

- `memory.recallAndSummarize`: recallAndSummarize(query: string, options?: Record<string, unknown>): Promise<unknown>
- `memory.browseForAnswer`: browseForAnswer(request: Record<string, unknown>): Promise<unknown>
