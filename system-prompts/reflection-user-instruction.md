## 任务

请根据以上数据，对聊天进行反思总结，输出严格符合要求的 JSON 对象。

## 输入数据说明

你收到的数据由以下章节组成（用 `---` 分隔），部分章节可能缺失：

- **群组信息**：群名、agent 角色、活跃度、热点话题、上次反思时间
- **近期话题 (N 个)**：每个话题包含标签、摘要、参与者、关键词、情感、Agent 介入情况、消息数
- **近期交互 (N 条)**：agent 参与的交互日志（类型: agent_replied / agent_mentioned / direct_message / reaction）
- **参与者统计**：每位用户的消息数、话题数、活跃天数
- **现有画像 (N 人)**：用户当前的 Tier、traits、interests、style、relation

## 输出原则

1. **personUpdates**：只包含有实质性变化的画像字段。如果某人的 traits 没有新发现，不要重复已有内容
2. **newFacts**：只提取值得长期记忆的具体信息（如"alice 下周去东京"），避免模糊概括
3. **anecdote**：特别注意标注有趣的轶事（category='anecdote'）
4. **dunbarTier**：基于交互频率和深度综合判断，不要仅凭单次对话升降，需提供具体 dunbarReason
5. **topicsSummary**：每个话题摘要简洁（1-2句），sentiment 反映话题整体氛围
6. **insights**：提供具体、可操作的建议（如"alice 对旅行话题很感兴趣，下次可以主动聊"），不要泛泛而谈
7. **groupUpdates**：
   - `engagementLevel`：基于消息频率和参与人数综合判断
   - `hotTopics`：取最近最活跃的 3-5 个话题标签
   - `tabooTopics`：识别群内不受欢迎或引发争议的话题
   - `description`：用一句话概括群组的定位和核心特征
   - `communicationNorms`：总结群内的交流风格（如"喜欢发梗图"、"技术讨论为主"）
8. **identityUpdates**：仅在发现用户改名或群友用新的称呼叫某人时才提供


## 输出数据结构


你需要输出一个 **严格的 JSON 对象**（不要包含任何 markdown 代码块或额外文本），包含以下字段：

{
  "personUpdates": [
    {
      "userId": "string (用户ID)",
      "traits": ["性格特点"],
      "interests": ["兴趣话题"],
      "communicationStyle": "string (说话风格概述)",
      "relationToAgent": "string (与 agent 的关系)",
      "dunbarTier": 1-4,
      "dunbarReason": "string (分层理由)"
    }
  ],
  "identityUpdates": [
    {
      "userId": "string (用户ID)",
      "displayName": "string (当前显示名，如有变化)",
      "aliases": ["string (已知的其他称呼/昵称)"]
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
  "newFacts": [
    {
      "subject": "string (事实主体，如 userId)",
      "content": "string (事实内容)",
      "category": "preference|biographical|anecdote|relationship|skill|opinion"
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
  "insights": "string (对未来行为的反思建议)"
}

**邓巴分层指引**：
- Tier 1 (核心, ≤15人): 高频互动、情感连接强、主动寻求 agent 帮助
- Tier 2 (熟悉, ≤50人): 定期互动、有共同话题、偶尔直接交流
- Tier 3 (认识, ≤150人): 偶尔出现、有限互动
- Tier 4 (陌生): 极少或首次出现

**事实分类说明**：
- preference: 个人偏好（如喜欢的食物、音乐）
- biographical: 个人信息（如职业、所在城市）
- anecdote: 有趣的轶事（永不过期）
- relationship: 人际关系
- skill: 技能和专长
- opinion: 观点和立场

**identityUpdates 说明**：
- 仅在用户的显示名或别名发生变化时才需要包含
- aliases 是该用户在群中被其他人叫的各种称呼（不含 userId 本身）
- 如果没有身份变化，返回空数组 []
