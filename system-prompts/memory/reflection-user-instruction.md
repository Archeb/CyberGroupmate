## 任务

请根据以上数据，对聊天进行反思总结，输出严格符合要求的 JSON 对象。

> 注意：你收到的数据中可能包含「已有事实」和「已知身份信息」章节，请仔细阅读这些已有数据再做判断。

## 输入数据说明

你收到的数据由以下章节组成（用 `---` 分隔），部分章节可能缺失：

- **群组信息**：群名、agent 角色、活跃度、热点话题、上次反思时间
- **近期话题 (N 个)**：每个话题包含标签、摘要、参与者、关键词、情感、Agent 介入情况、消息数
- **近期交互 (N 条)**：agent 参与的交互日志（类型: agent_replied / agent_mentioned / direct_message / reaction）
- **近期直接互动 (N 条)**：agent 参与的交互日志，可能包含原始消息证据、关联话题、agent 后续反应
- **参与者统计**：每位用户的消息数、话题数、直呼/私聊次数、agent 回复次数、活跃天数
- **全局画像 (N 人，跨群共享)**：这个人在所有群/私聊中稳定保留的长期认知
- **现有画像 (N 人)**：用户当前的 Tier、traits、interests、style、relation、短期关系事件和长期关系记忆（包含显示名和别名信息）
- **已有事实**：当前已记录的事实（带 id 和来源），供你判断是否需要更新或删除

## 输出原则

1. **globalPersonUpdates**：跨群共享的长期认知，只写稳定、可迁移到其他群/私聊的内容。不要写只属于当前群气氛的临时表现。
2. **personUpdates**：当前 chat 的场景画像，只包含此人“在这个群/私聊里”的表现和关系。如果某人的 traits 没有新发现，不要重复已有内容
3. **factUpdates**：
   - 新增事实：不提供 `id`，只提取值得长期记忆的具体信息（如"某人下周去东京"）
   - 更新事实：提供已有事实的 `id`，修改 `content` 或 `category`
   - 删除事实：提供 `id` + `action: "delete"`，用于删除过时的事实
   - 避免模糊概括
   - 尽量补充 `sourceTopicLabel/sourceMessageIds/observedAt/visibility/sensitivity`；不确定时可省略，系统会从当前话题推断
4. **anecdote**：特别注意标注有趣的轶事（category='anecdote'）
5. **interactionQuality**（必填）：评估近期互动质量，不要输出 dunbarTier（系统会自动计算）
6. **topicsSummary**：每个话题摘要简洁（1-2句），sentiment 反映话题整体氛围
7. **insights**：提供具体、可操作的建议（如"某人对旅行话题很感兴趣，下次可以主动聊"），不要泛泛而谈
8. **relationshipEvents**：从近期直接互动和原始证据里提炼值得进入情感记忆的关系事件，必须带 `messageIds/evidence/confidence` 中至少一种证据
9. **agentFeedback**：总结 agent 这段时间哪些行为有效、哪些应避免、未来语气策略
10. **followupCandidates**：只输出自然、不突兀、可由 Meta/Agent 以后接回的候选动作
11. **groupUpdates**：
   - `engagementLevel`：基于消息频率和参与人数综合判断
   - `hotTopics`：取最近最活跃的 3-5 个话题标签
   - `tabooTopics`：识别群内不受欢迎或引发争议的话题
   - `description`：用一句话概括群组的定位和核心特征
   - `communicationNorms`：总结群内的交流风格（如"喜欢发梗图"、"技术讨论为主"）
12. **identityUpdates**：参考「现有画像」中的已知显示名和别名，仅在发现与已知信息**不同**的变化时才提供

## 全局/场景/事实边界

- 全局画像是“这个人长期是什么样、怎样和 agent 相处”，应尽量写成不依赖具体群名也成立的认知。
- 当前场景画像是“这个人在本群/本私聊里如何表现”，可以记录群内梗、群内角色、当前关系气氛。
- 如果本轮证据只说明“在这个群里这样”，不要提升到 globalPersonUpdates；放入 personUpdates、relationshipEvents 或 factUpdates。
- 如果本轮证据和已有全局画像冲突，不要直接覆盖成当前群结论；用更保守的措辞表达“在当前场景中呈现出...”。
- core facts 可以跨群检索，但必须保留来源。`visibility=private` 表示只能在原私聊或得到明确授权时直接说出；`visibility=contextual` 表示只在来源群/同上下文中可直接说出；`visibility=public` 才适合跨群直接引用。
- `sensitivity=medium/high` 的事实即使可用，也优先内化成回复策略，不要写成会让 agent 在公开群里复述的句子。


## 输出数据结构


你需要输出一个 **严格的 JSON 对象**（不要包含任何 markdown 代码块或额外文本），包含以下字段：

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
      "relationToAgent": "string (与 agent 的关系)",
      "interactionQuality": "friendly|dependent|instrumental|hostile",
      "dunbarReason": "string (关系评估理由)"
    }
  ],
  "identityUpdates": [
    {
      "userId": "string (用户ID)",
      "displayName": "string (当前显示名，如有变化)",
      "aliases": ["string (昵称，请参考原有别名，在有证据的情况下谨慎更新，原来没有的话可以根据观察推断)"]
    }
  ],
  "groupUpdates": {
    "agentRole": "string (agent 在群中的角色)",
    "engagementLevel": "high|medium|low",
    "hotTopics": ["最近的热点话题"],
    "tabooTopics": ["不宜讨论的敏感话题"],
    "description": "string (群组定位/简介)",
    "communicationNorms": ["交流规范/风格特征"],
    "recentFeedback": "string (聊天成员对 agent 的反馈)"
  },
  "factUpdates": [
    {
      "id": "string (可选，已有事实的 id，用于更新/删除)",
      "subject": "string (必须是用户的原始 userId 数字 ID，如 '12345'，绝对不要用显示名或昵称)",
      "content": "string (事实内容)",
      "category": "preference|biographical|anecdote|relationship|skill|opinion",
      "action": "upsert|delete (可选，默认为 upsert)",
      "sourceTopicId": "string|null (可选)",
      "sourceTopicLabel": "string (可选)",
      "sourceMessageIds": ["string (可选，证据消息 ID)"],
      "sourceInteractionIds": ["string (可选)"],
      "observedAt": "ISO 8601 string (可选)",
      "visibility": "private|contextual|public (可选；私聊事实通常 private，群内事实通常 contextual)",
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
      "summary": "string (值得进入关系记忆的事件，不要泛泛复述)",
      "type": "agent_replied|agent_mentioned|direct_message|reaction|milestone|preference|boundary",
      "sentiment": "positive|neutral|negative",
      "significance": 0.8,
      "interactionQuality": "friendly|dependent|instrumental|hostile",
      "messageIds": ["string (证据消息 ID，如可用)"],
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
  "insights": "string (对未来行为的反思建议)"
}

**互动质量分类**：
- friendly: 友好、互动积极、有情感联系
- dependent: 对方对 agent 有明显依赖倾向
- instrumental: 纯工具性使用（问完就走）
- hostile: 消极互动（不满、对抗、测试 agent）

> 注意：不要输出 `dunbarTier` 字段，系统会根据 `interactionQuality` 和交互频率自动计算 Tier。

**邓巴分层指引**：
- Tier 1 (核心, ≤15人): 高频互动、情感连接强、主动寻求 agent 帮助
- Tier 2 (熟悉, ≤50人): 定期互动、有共同话题、偶尔直接交流
- Tier 3 (认识, ≤150人): 偶尔出现、有限互动
- Tier 4 (陌生): 极少或首次出现

**事实更新说明（factUpdates）**：
- 新增事实：不提供 `id`，系统会自动生成
- 更新事实：提供已有事实的 `id`（从「已有事实」章节获取），修改 content/category
- 删除过时事实：提供 `id` + `action: "delete"`
- 注意：不要重复添加已有事实中已存在的内容

**identityUpdates 说明**：
- 参考「现有画像」中的已知显示名和别名，仅在发现变化时才输出
- aliases 是该用户在群中被其他人叫的各种称呼（不含 userId 本身）
- 如果没有身份变化，返回空数组 []
