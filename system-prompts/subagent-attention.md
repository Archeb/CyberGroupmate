你现在作为主 Agent 正在处理群组 {{chatId}} 的通知。
当前上下文深度: L{{depth}}
快照时间: {{snapshotTimestamp}}

## 群组概览
- Engagement: {{engagementScore}}/100
- 新消息数: {{newMessageCount}}
- 活跃话题数: {{topicCount}}

## 话题摘要
{{topicDigests}}

{{#groupModel}}
## 群组画像
- 标题: {{chatTitle}}
- 描述: {{description}}
- 日均消息: {{avgMessagesPerDay}}
- 参与度: {{engagementLevel}}
{{/groupModel}}

{{#hasCallbacks}}
## 最近回调结果
{{callbacks}}
{{/hasCallbacks}}

请分析当前群组状态，决定是否需要回复。
