## 任务

请根据以上数据，对这段**私聊**进行反思总结，输出严格符合要求的 JSON 对象。

## 输入数据说明

你收到的数据由以下章节组成（用 `---` 分隔），部分章节可能缺失：

- **私聊信息**：对话对象、agent 角色、活跃度、上次反思时间
- **近期话题与对话**：话题摘要、关键词、参与者和原始消息片段
- **近期直接互动**：agent 参与的交互日志，可能包含原始消息证据、关联话题、agent 后续反应
- **参与者统计**：消息数、话题数、直呼/私聊次数、agent 回复次数、活跃天数
- **全局画像**：该用户跨群/跨私聊共享的长期认知
- **现有画像**：该用户在此私聊中的 Tier、traits、interests、style、relation、短期关系事件和长期关系记忆
- **已有事实**：当前已记录的事实（带 id 和来源），供你判断是否需要更新或删除

## 输出原则（私聊特化）

1. **globalPersonUpdates**：输出跨群共享的长期认知，例如稳定偏好、总体关系、长期互动策略；不要写只属于当前几句话的临时情绪。
2. **personUpdates**：深入分析一对一关系动态，只输出此私聊场景里确有变化的字段。
3. **relationToAgent**：精确描述关系类型、情感色彩和对方对 agent 的期待。
4. **interactionQuality**（必填）：评估整体互动质量：`friendly` / `dependent` / `instrumental` / `hostile`。
5. **factUpdates**：使用 `factUpdates`，不要使用旧字段 `newFacts`。新增事实不提供 id；更新/删除已有事实必须提供 id。尽量补充来源字段；系统会自动补当前私聊来源。
6. **relationshipEvents**：从近期直接互动和原始证据里提炼值得进入情感记忆的关系事件，必须带 `messageIds/evidence/confidence` 中至少一种证据。
7. **agentFeedback**：总结 agent 这段时间哪些行为有效、哪些应避免、未来语气策略。
8. **followupCandidates**：只输出自然、不突兀、可之后接回的候选动作。
9. **groupUpdates**：私聊中描述的是「私聊关系」而非群组；`description` 写关系定位，`communicationNorms` 写对话模式。
10. **identityUpdates**：仅在发现用户改名或别名变化时才提供。

## 全局/私聊/事实边界

- 私聊经常包含亲密、敏感或只适合一对一使用的信息。可以把稳定偏好和长期互动策略提升到 globalPersonUpdates，但不要把私聊细节写成公开场合可复述的画像。
- globalPersonUpdates 应写“长期如何回应此人”，而不是“在这次私聊里发生了什么”。
- personUpdates 可以更细地描述此私聊关系，但仍只写未来有用且有证据的变化。
- 私聊事实默认 `visibility=private`；只有用户明确表达可以公开、或事实本身明显公开无敏感性时，才使用 `public`。
- 亲密互动、隐私边界、成人/擦边边界、个人日常细节等，通常 `sensitivity=medium/high`，优先作为 agent 内部策略，不应跨群直接说出。

## 输出数据结构

你需要输出一个 **严格的 JSON 对象**（不要包含任何 markdown 代码块或额外文本）：

{
  "globalPersonUpdates": [
    {
      "userId": "string (用户ID)",
      "traits": ["跨群稳定性格/行为特点"],
      "interests": ["跨群长期兴趣和偏好"],
      "communicationStyle": "string (跨群一致沟通风格)",
      "relationToAgent": "string (与 agent 的总体关系)",
      "stablePatterns": ["稳定互动模式"],
      "agentPolicyHints": ["agent 对此人的长期响应策略"],
      "followupCandidates": ["可自然回访的长期候选"],
      "confidence": 0.8
    }
  ],
  "personUpdates": [
    {
      "userId": "string (用户ID)",
      "traits": ["性格特点"],
      "interests": ["兴趣话题"],
      "communicationStyle": "string (说话风格概述)",
      "relationToAgent": "string (与 agent 的关系定性，私聊中需更详细)",
      "interactionQuality": "friendly|dependent|instrumental|hostile",
      "dunbarReason": "string (关系评估理由)"
    }
  ],
  "identityUpdates": [
    {
      "userId": "string (用户ID)",
      "displayName": "string (当前显示名，如有变化)",
      "aliases": ["string (昵称/别名，仅在有证据时谨慎更新)"]
    }
  ],
  "groupUpdates": {
    "agentRole": "string (agent 在此私聊中的角色)",
    "engagementLevel": "high|medium|low",
    "hotTopics": ["最近的热点话题"],
    "tabooTopics": ["敏感或对方不愿讨论的话题"],
    "description": "string (此私聊关系的定位/简介)",
    "communicationNorms": ["交流模式/习惯特征"],
    "recentFeedback": "string (对方对 agent 的反馈/态度)"
  },
  "factUpdates": [
    {
      "id": "string (可选，已有事实 id，用于更新/删除)",
      "subject": "string (必须是用户的原始 userId 数字 ID，如 '12345')",
      "content": "string (事实内容)",
      "category": "preference|biographical|anecdote|relationship|skill|opinion",
      "action": "upsert|delete (可选，默认为 upsert)",
      "sourceTopicId": "string|null (可选)",
      "sourceTopicLabel": "string (可选)",
      "sourceMessageIds": ["string (可选，证据消息 ID)"],
      "sourceInteractionIds": ["string (可选)"],
      "observedAt": "ISO 8601 string (可选)",
      "visibility": "private|contextual|public (可选；私聊事实默认 private)",
      "sensitivity": "low|medium|high (可选)"
    }
  ],
  "topicsSummary": [
    {
      "label": "string",
      "summary": "string",
      "participants": ["userId"],
      "sentiment": "positive|neutral|negative|mixed"
    }
  ],
  "relationshipEvents": [
    {
      "userId": "string (用户ID)",
      "summary": "string (值得进入关系记忆的事件)",
      "type": "agent_replied|agent_mentioned|direct_message|reaction|milestone|preference|boundary",
      "sentiment": "positive|neutral|negative",
      "significance": 0.8,
      "interactionQuality": "friendly|dependent|instrumental|hostile",
      "messageIds": ["string"],
      "topicId": "string|null",
      "topicLabel": "string",
      "evidence": ["string (简短原文证据)"],
      "agentOutcome": "string (agent 后续反应或结果)",
      "confidence": 0.8
    }
  ],
  "agentFeedback": {
    "effectiveBehaviors": ["string"],
    "avoidBehaviors": ["string"],
    "toneHints": ["string"]
  },
  "followupCandidates": [
    {
      "userId": "string (可选)",
      "topic": "string",
      "reason": "string",
      "suggestedAction": "string"
    }
  ],
  "insights": "string (对未来一对一互动的反思建议)"
}

**事实更新说明**：
- 不要重复添加已有事实中已存在的内容。
- 私聊可能包含更深的个人信息，但仍只记录用户愿意在聊天中表达、未来有用且不敏感的信息。
- 不确定的信息不要写，或者在 relationshipEvents 的 confidence 中体现不确定。
