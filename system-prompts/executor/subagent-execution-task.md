═══ {{taskId}} ═══
聊天对象: {{chatTitle}} (chatId: {{chatId}}) [{{chatType}}]


## 参考回复方式

{{decisions}}
语气: {{toneGuidance}}

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

{{#hasGroundingContext}}
## 事实查证
以下是通过联网搜索获得的相关事实信息，请在回复中参考（如涉及事实性内容）：
{{groundingContext}}
{{/hasGroundingContext}}

请根据以上任务信息，编写代码完成任务。先做事（下载/查询/处理），确认结果后再 sendMessage。