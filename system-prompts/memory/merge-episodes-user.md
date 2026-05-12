## 任务

对用户 **{{userId}}** 的 {{count}} 条交互事件进行综合分析，生成合并后的记忆摘要。

## 输入数据格式

以下每行是一条交互事件，格式为：
```
- [<ISO日期>] (情感:<positive|neutral|negative>, 重要度:<0-1>, 类型:<direct_message|agent_mentioned|agent_replied|reaction>, 话题:<topic>, 质量:<friendly|dependent|instrumental|hostile>, 置信度:<0-1>) <事件摘要>
  证据: <发言人: 原文片段> / <...>
  结果: <agent 后续反应，如有>
```

### 事件列表

{{eventLines}}

### 既有记忆基线

以下内容是该用户在全局和当前 chat 中的既有认知，只作为参照：
- 用来判断本次事件是在延续旧模式、强化旧模式、修正旧模式，还是出现新变化。
- 不要因为基线里已有某条信息，就在输出中无证据重复；输出必须主要由“事件列表”支持。
- 如果事件列表只是在延续旧模式，可以明确写“延续/强化了既有模式”。

{{existingMemoryContext}}

## 输出 JSON Schema

输出一个**严格的 JSON 对象**，不要包含 markdown 代码块或额外文本：

```json
{
  "overallSentiment": "positive|neutral|negative|mixed",
  "highlights": ["string (提炼后的重要事件摘要，1-3条)"],
  "relationshipTrend": "string (一句话描述关系变化趋势)",
  "stablePatterns": ["string (稳定互动模式，0-5条)"],
  "userPreferences": ["string (有证据支持的偏好/雷点/习惯，0-5条)"],
  "agentPolicyHints": ["string (未来 agent 使用的互动提示，0-5条)"],
  "salientEvents": [
    {
      "summary": "string (关键事件)",
      "sourceIds": ["string"],
      "confidence": 0.8
    }
  ],
  "followupCandidates": ["string (可自然回访的话题或动作，0-5条)"],
  "confidence": 0.8
}
```

## 字段分析指南

### overallSentiment
综合所有事件的情感和重要度权重进行判断：
- 高重要度事件的情感权重更大
- 正面和负面事件数量接近时使用 `mixed`
- 所有事件都偏向同一方向时直接使用对应值

### highlights
从所有事件中提炼最值得长期记住的 1-3 件事，优先级为：
1. 关系转折点（如首次主动交流、发生冲突）
2. 有趣/独特的互动（如教了一个冷笑话、分享了个人经历）
3. 重要度 > 0.7 的事件
- 不要简单复制原文，要**提炼概括**，使其脱离上下文后仍可理解
- 如果事件很少或很平淡，返回空数组 `[]`

### relationshipTrend
用一句话描述关系的**变化方向**，要具体、有画面感：
- ✅ "从以前只看不说话，到开始主动分享技术问题"
- ✅ "互动增多，从话题讨论扩展到开玩笑"
- ❌ "关系正常"
- ❌ "保持互动"
- 如果事件平淡无明显变化，写 "互动平淡，无明显变化"

### stablePatterns / userPreferences / agentPolicyHints
- stablePatterns 是“反复出现”的相处规律，不是单条消息复述。
- userPreferences 只写之后能帮助接话或避免踩雷的信息。
- agentPolicyHints 要能直接指导后续回复风格或行动。
- 不确定的信息不要写，或者在 confidence 中体现不确定。
- 这是对单个用户在一个 chat 中的事件合并：如果规律只适用于本群/本私聊，请在文字中明确“在本群/此私聊中”；只有跨场景也明显成立的规律才写成无场景限定的长期偏好。
- 私聊、敏感边界或跨群来源相关的信息可以沉淀为内部策略，但不要写成未来 agent 可以在任意群公开复述的句子。
