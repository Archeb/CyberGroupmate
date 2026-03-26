## 任务

请根据以上数据，对聊天进行反思总结，输出严格符合要求的 JSON 对象。

> 注意：你收到的数据中可能包含「已有事实」和「已知身份信息」章节，请仔细阅读这些已有数据再做判断。

## 输入数据说明

你收到的数据由以下章节组成（用 `---` 分隔），部分章节可能缺失：

- **群组信息**：群名、agent 角色、活跃度、热点话题、上次反思时间
- **近期话题 (N 个)**：每个话题包含标签、摘要、参与者、关键词、情感、Agent 介入情况、消息数
- **近期交互 (N 条)**：agent 参与的交互日志（类型: agent_replied / agent_mentioned / direct_message / reaction）
- **参与者统计**：每位用户的消息数、话题数、活跃天数
- **现有画像 (N 人)**：用户当前的 Tier、traits、interests、style、relation（包含显示名和别名信息）
- **已有事实**：当前已记录的事实（带 id），供你判断是否需要更新或删除

## 输出原则

1. **personUpdates**：只包含有实质性变化的画像字段。如果某人的 traits 没有新发现，不要重复已有内容
2. **factUpdates**：
   - 新增事实：不提供 `id`，只提取值得长期记忆的具体信息（如"某人下周去东京"）
   - 更新事实：提供已有事实的 `id`，修改 `content` 或 `category`
   - 删除事实：提供 `id` + `action: "delete"`，用于删除过时的事实
   - 避免模糊概括
3. **anecdote**：特别注意标注有趣的轶事（category='anecdote'）
4. **interactionQuality**（必填）：评估近期互动质量，不要输出 dunbarTier（系统会自动计算）
5. **topicsSummary**：每个话题摘要简洁（1-2句），sentiment 反映话题整体氛围
6. **insights**：提供具体、可操作的建议（如"某人对旅行话题很感兴趣，下次可以主动聊"），不要泛泛而谈
7. **groupUpdates**：
   - `engagementLevel`：基于消息频率和参与人数综合判断
   - `hotTopics`：取最近最活跃的 3-5 个话题标签
   - `tabooTopics`：识别群内不受欢迎或引发争议的话题
   - `description`：用一句话概括群组的定位和核心特征
   - `communicationNorms`：总结群内的交流风格（如"喜欢发梗图"、"技术讨论为主"）
8. **identityUpdates**：参考「现有画像」中的已知显示名和别名，仅在发现与已知信息**不同**的变化时才提供


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
      "subject": "string (事实主体，如 userId)",
      "content": "string (事实内容)",
      "category": "preference|biographical|anecdote|relationship|skill|opinion",
      "action": "upsert|delete (可选，默认为 upsert)"
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
