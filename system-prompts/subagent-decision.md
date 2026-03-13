基于以下群组上下文，请做出回复决策：

群组: {{chatId}}
Engagement: {{engagementScore}}/100
回复模式建议: {{suggestedReplyMode}}

## 活跃话题
{{topicDigests}}

{{#hasMessages}}
## 最近消息
{{messages}}
{{/hasMessages}}

请返回 JSON 格式决策：
{
  "replyMode": "NONE|SINGLE|BATCH",
  "decisions": [
    {"action": "REPLY|IGNORE|DEFER", "topicId": "...", "contentDirection": "...", "confidence": 0.8, "reason": "..."}
  ],
  "reasoning": "..."
}
