## 任务

请根据以上数据，对这段**私聊**进行反思总结，输出严格符合要求的 JSON 对象。

## 输入数据说明

你收到的数据由以下章节组成（用 `---` 分隔），部分章节可能缺失：

- **私聊信息**：对话对象、agent 角色、活跃度、上次反思时间
- **近期话题 (N 个)**：每个话题包含标签、摘要、关键词、情感、消息数
- **近期交互 (N 条)**：agent 参与的交互日志（类型: agent_replied / direct_message / reaction）
- **参与者统计**：对话双方的消息数、话题数、活跃天数
- **现有画像**：该用户当前的 Tier、traits、interests、style、relation
- **已知身份信息**：该用户已有的 displayName、username、aliases

## 输出原则（私聊特化）

1. **personUpdates**：深入分析一对一关系动态。重点关注：
   - 对方主动发起对话的频率和目的（寻求帮助、闲聊、情感倾诉）
   - 对话的亲密度变化趋势（是否越来越信任 agent、是否有情感依赖倾向）
   - 对方对 agent 的期待和需求（工具性使用 vs 社交陪伴 vs 知识咨询）
2. **relationToAgent**（重要）：私聊中此字段尤为关键，需要精确描述关系定性：
   - 关系类型（如"技术咨询者"、"日常闲聊伙伴"、"偶尔求助"、"深度交流对象"）
   - 情感色彩（如"友好信任"、"工具性使用"、"有一定依赖"、"保持距离"）
3. **interactionQuality**（必填）：评估整体互动质量
   - `friendly`: 友好、互动积极、有情感联系
   - `dependent`: 对方对 agent 有明显依赖倾向
   - `instrumental`: 纯工具性使用（问完就走）
   - `hostile`: 对抗、不满、消极互动
4. **newFacts**：私聊中更容易获取深度个人信息（如真实想法、私人计划），应重点提取
5. **topicsSummary**：简洁总结即可
6. **insights**：围绕一对一关系的维护建议（如"对方近期情绪低落，下次可以主动关心"、"对方只在需要翻译时私聊，关系偏工具性"）
7. **groupUpdates**：在私聊中，此字段描述的是「私聊关系」而非群组：
   - `description`: 描述这段私聊关系的性质
   - `engagementLevel`: 私聊的活跃度
   - `communicationNorms`: 对话中的模式/习惯
   - 其他字段按需填充
8. **identityUpdates**：仅在发现用户改名时才提供

## 输出数据结构

你需要输出一个 **严格的 JSON 对象**（不要包含任何 markdown 代码块或额外文本），包含以下字段：

{
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
      "aliases": ["string (昵称，请参考原有别名，在有证据的情况下谨慎更新，原来没有的话可以根据观察推断)"]
    }
  ],
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
  "insights": "string (对未来一对一互动的反思建议)"
}

**互动质量分类说明**：
- friendly: 积极友好的互动，有情感联系，对话愉快
- dependent: 对方对 agent 有较强依赖（频繁发起、情感寄托、期待即时回复）
- instrumental: 工具性互动（有需求才来、问完即走、无闲聊）
- hostile: 消极互动（不满、对抗、投诉、测试 agent）

**事实分类说明**：
- preference: 个人偏好（如喜欢的食物、音乐）
- biographical: 个人信息（如职业、所在城市）
- anecdote: 有趣的轶事（永不过期）
- relationship: 人际关系
- skill: 技能和专长
- opinion: 观点和立场

**identityUpdates 说明**：
- 仅在用户的显示名或别名发生变化时才需要包含
- 如果没有身份变化，返回空数组 []
