以下是来自群组 {{chatId}} 的 Subagent 执行结果：

任务 ID: {{taskId}}
状态: {{status}}
摘要: {{summary}}

{{#hasSentMessages}}
## 已发送消息
{{sentMessages}}
{{/hasSentMessages}}

{{#hasError}}
## 错误信息
{{error}}
{{/hasError}}

请更新全局状态并决定后续动作。
