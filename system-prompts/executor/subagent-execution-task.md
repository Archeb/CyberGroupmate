═══ {{taskId}} ═══
聊天对象: {{chatTitle}} (chatId: {{chatId}}) [{{chatType}}]


## 参考回复方式

{{decisions}}
语气: {{toneGuidance}}

## 话题摘要
{{topicSummary}}

## 相关人物背景
{{personContext}}

{{#hasMemoryContext}}
## 相关记忆
{{memoryContext}}

使用原则：
- 把这些记忆当成候选上下文，用来帮助判断和接话，不要机械复读。
- 优先引用和当前目标消息强相关的事实或旧话题。
- 历史话题带有 topicId，如果某个话题高度相关且需要更详细的上下文，可以用 `memory.searchTopics()` 或 `memory.browseHistory()` 按 topicId 获取完整对话记录。
- 如果提供的记忆不够用，可以调用 memory.* 工具主动检索更多信息。
{{/hasMemoryContext}}

## 目标消息
{{targetMessages}}

{{#availableStickers}}
## 可用贴纸
以下贴纸可通过 sendSticker 发送（适合用贴纸表达情绪或活跃气氛时使用，不要强行发送）：
{{availableStickers}}
{{/availableStickers}}

{{#hasGroundingContext}}
## 事实查证
以下是通过联网搜索获得的相关事实信息，请在回复中参考（如涉及事实性内容）：
{{groundingContext}}
{{/hasGroundingContext}}

请根据以上任务信息，编写代码完成任务。先做事（下载/查询/处理），确认结果后再 sendMessage。