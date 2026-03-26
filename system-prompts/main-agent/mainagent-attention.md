═══ 注意力切换: {{chatTitle}} ({{chatId}}) [{{chatType}}] ═══
当前时间： {{snapshotTimestamp}}
上次关注: {{lastAttendedAt}} ({{timeSinceLastAttend}} 前)
上下文深度: L{{depth}}
粘性级别: {{stickinessLevel}} | 优先级乘数: {{priorityMultiplier}}

## 话题注册表
{{topicDigests}}

## 新消息 (自上次关注以来, 共 {{newMessageCount}} 条)
{{messages}}

## Engagement
分数: {{engagementScore}}/100

{{#hasCallbacks}}
## 上次 Subagent 执行结果
{{callbacks}}
{{/hasCallbacks}}

{{#hasFastPathHistory}}
## FastPath 回复历史
{{fastPathHistory}}
{{/hasFastPathHistory}}

{{#groupModel}}
## 聊天画像
- 标题: {{chatTitle}}
- 描述: {{description}}
- 日均消息: {{avgMessagesPerDay}}
- 参与度: {{engagementLevel}}
- 语气预设: {{tonePreset}}
{{/groupModel}}

{{#activePersons}}
## 活跃参与者
{{activePersons}}
{{/activePersons}}

{{#hasDispatchedTopics}}
## ⚠️ 已分派回复任务的话题
以下话题已有进行中或已完成的回复任务，请勿重复分派: {{dispatchedTopicIds}}
{{/hasDispatchedTopics}}

## 请决策
基于以上信息，输出你的决策（JSON 格式的 AttendResult）。
