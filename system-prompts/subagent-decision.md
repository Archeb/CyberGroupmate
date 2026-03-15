输出格式要求（JSON）:
```json
{
  "replyMode": "NONE | SINGLE | BATCH",
  "decisions": [
    {
      "action": "REPLY | IGNORE | DEFER | FAST_PATH_AUTH",
      "topicId": "topic_xxx",
      "targetMessageIds": ["msg_38", "msg_39"],
      "contentDirection": "具体的内容方向指示（必填 for REPLY）",
      "toneGuidance": "语气要求",
      "confidence": 0.8,
      "reason": "决策理由"
    }
  ],
  "fastPathAuth": {
    "preauthorizedActions": ["回答直接问题", "简短回应"],
    "maxRepliesBeforeReauth": 3,
    "expiresInMinutes": 5
  },
  "reasoning": "整体决策思路"
}
```

决策规则:
- 当前粘性级别: {{stickinessLevel}}
- REPLY: 需要给出明确的 contentDirection（内容方向）和 toneGuidance（语气）
- IGNORE: 说明不介入的理由
- DEFER: 非紧急，下次再看
- FAST_PATH_AUTH: 仅在高 engagement + 频繁 @ 场景下授权。{{stickinessLevel}} 为 ACQUAINTANCE 或 STRANGER 时禁止授权
- BATCH 模式: 多话题时，每个需要回复的话题生成一条 REPLY 决策
- 回复建议模式: {{suggestedReplyMode}}

仅返回 JSON，不要包含其他文本。
