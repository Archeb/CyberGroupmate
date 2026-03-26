以纯JSON格式输出:
```json
{
  "replyMode": "NONE | SINGLE",
  "decisions": [
    {
      "action": "REPLY | IGNORE | DEFER",
      "topicId": "",
      "targetMessageIds": ["12345", "12346"],
      "contentDirection": "具体的行动指示（先如何思考，要获取哪些信息，再回复谁）",
      "toneGuidance": "语气要求",
      "suggestedEmojis": ["😂", "🤔"],
      "confidence": 0.8,
      "reason": "决策理由"
    }
  ],
  "reasoning": "整体决策思路"
}
```

决策规则:
- 当前粘性级别: {{stickinessLevel}}
- topicId: 必须使用话题注册表中提供的真实 topicId（格式如 topic_xxx_0001）。如果无活跃话题或不确定归属，topicId 留空字符串 ""。**不要自行编造 topic ID**。
- targetMessageIds: 从上下文消息中选择需要回复的消息 ID（即消息原文中的 msg#xxx 编号）。这决定了 subagent 将回复谁。**必须使用上下文中出现的真实消息 ID**。
- toneGuidance: 根据群组氛围和粘性级别给出具体语气指导（如"随意友好"、"正经讨论"、"带点调侃"）
- suggestedEmojis: 为 REPLY 决策根据当前语境/情绪提供 2-4 个相关 emoji，用于查找可发送的贴纸
- REPLY: 需要给出明确的 contentDirection（内容方向）、targetMessageIds（回复目标）、toneGuidance（语气）和 suggestedEmojis（相关表情）
- IGNORE: 说明不介入的理由
- DEFER: 非紧急，下次再看

仅返回 JSON，不要包含其他文本。
