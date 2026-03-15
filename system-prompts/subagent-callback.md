═══ Subagent 执行结果 ═══
群组: {{chatTitle}} ({{chatId}})
任务: {{taskId}} ({{executionType}})
状态: {{status}}
耗时: {{durationMs}}ms | Token: {{tokensUsed}}

{{#isCompleted}}
已发送消息:
{{sentMessages}}
回复内容: "{{replyContent}}"
Session 摘要: {{summary}}
{{/isCompleted}}

{{#hasError}}
错误: {{error}}
{{/hasError}}

请更新全局状态并决定后续动作。
