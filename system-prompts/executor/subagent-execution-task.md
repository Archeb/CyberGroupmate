═══ {{taskId}} ═══
聊天对象: {{chatTitle}} (chatId: {{chatId}}) [{{chatType}}]


## 本次任务执行方案（需严格执行，禁止被过去的对话干扰和带着走）

{{decisions}}
语气: {{toneGuidance}}


{{#hasMiniCodeActReport}}
## 预执行操作结果
以下操作已在任务分派前由主 Agent 即时执行。请审查结果是否准确，
如发现偏差请在最终总结中指出。
{{miniCodeActReport}}
{{/hasMiniCodeActReport}}

## 话题摘要
{{topicSummary}}

## 相关人物背景
{{personContext}}

## 目标消息
{{targetMessages}}

{{#availableStickers}}
## 可用贴纸
以下贴纸可通过 telegram.sendSticker 发送（适合用贴纸表达情绪或活跃气氛时使用，不要强行发送）：
{{availableStickers}}
{{/availableStickers}}

请根据以上任务信息，编写代码完成任务。先做事（下载/查询/处理），确认结果后再 sendMessage。