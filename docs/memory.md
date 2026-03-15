# Memory V2 — 设计文档

| 属性 | 值 |
|-----|-----|
| **状态** | `REVIEW` — 设计完成，待 review |
| **关联任务** | Phase 6.0 — Memory V2 完全重写 |
| **作者** | arc |
| **创建日期** | 2026-02-27 |
| **最后更新** | 2026-03-05 |
| **依赖** | `better-sqlite3`, `sqlite-vec`（Phase M4）, `js-tiktoken`（Phase M4）, `text-embedding-3-small`（Phase M4） |

## 目录

- [0. 设计目标](#0-设计目标)
- [1. 三层记忆模型概览](#1-三层记忆模型概览)
- [2. 短期记忆：智能上下文 Compaction](#2-短期记忆智能上下文-compaction)
  - [2.1 问题空间](#21-问题空间)
  - [2.2 分段式上下文管理](#22-设计方案分段式上下文管理)
  - [2.3 Compaction 触发策略](#23-compaction-触发策略)
  - [2.4 执行流程](#24-compaction-执行流程)
  - [2.5 话题连贯性保护](#25-话题连贯性保护)
  - [2.6 模型能力自适应](#26-模型能力自适应)
  - [2.7 与现有代码的关系](#27-与现有代码的关系)
- [3. 中期记忆：Episodic + Social Memory](#3-中期记忆episodic--social-memory)
  - [3.1 数据模型](#31-数据模型)（TopicNode / PersonIdentity / PersonGroupProfile / GroupModel）
  - [3.2 情感记忆渐进合并](#32-情感记忆渐进合并)
  - [3.3 Reflection Skill](#33-中期记忆更新机制reflection-skill)
  - [3.4 SQLite 表结构](#34-sqlite-表结构)
  - [3.5 Compaction 与 Recording Pipeline 的职责划分](#35-compaction-与-recording-pipeline-的职责划分)
  - [3.6 话题生命周期：从实时到持久](#36-话题生命周期从实时到持久)
- [4. 统一检索入口 recall()](#4-统一检索入口-recall)
  - [4.1 Embedding 策略](#41-embedding-策略)
  - [4.2 事实分类 FactCategory](#42-事实分类-factcategory)
  - [4.3 RecallOptions / RecallResult](#43-recalloptions-与-recallresult)
  - [4.4 recall() 实现流程](#44-recall-实现流程)
- [5. 消息档案模块 Message Archive](#5-消息档案模块-message-archive)
  - [5.1 为什么需要消息档案](#51-为什么需要消息档案)
  - [5.2 消息存储 message_log](#52-消息存储)
  - [5.3 HistoryBrowseRequest / Result](#53-historybrowserequest--historybrowseresult)
  - [5.4 检索流程](#54-检索流程)
  - [5.5 模糊搜索设计](#55-模糊搜索的关键设计)
  - [5.6 与其他模块的关系](#56-与其他模块的关系)
- [6. 迁移策略](#6-迁移策略)
- [7. 已确认的设计决策](#7-已确认的设计决策)
- [附录 A：端到端示例](#附录-a记忆系统端到端示例)（6 个场景）

## 变更日志

| 版本 | 日期 | 变更内容 |
|-----|------|---------|
| v3.0 | 2026-03-05 | TopicNode 与 Pipeline Topic 双层融合；新增 Section 3.6 话题生命周期；Compaction/Recording Pipeline 职责划分；message_log 写入时机改为 Recording Pipeline |
| v2.4 | 2026-02-27 | 邓巴分层 → 画像精度挂钩；SOTA model 直接调用 browseHistory；A.2 示例扩展 |
| v2.3 | 2026-02-27 | 消息档案升级为一等模块（Section 5）；邓巴参数可配置；browseHistory 接口 |
| v2.2 | 2026-02-27 | js-tiktoken BPE 精确 token 计算；MergedPeriod → MergedMemory；程序化 activeHours |
| v2.1 | 2026-02-27 | FactCategory 系统；embedding 策略；RecallOptions/RecallResult；附录 A 6 个示例 |
| v2.0 | 2026-02-27 | 初始设计：三层记忆模型、智能 Compaction、Reflection Skill、recall() |

---

## 0. 设计目标

让 CyberGroupmate 拥有**类人的记忆层次**——当前对话流畅自然（短期）、当天话题了然于胸（中期）、核心事实与关系经久不忘（长期）。

在 Phase 1-5 中，记忆系统是三张扁平表 (`memories`, `person_profiles`, `conversation_log`) + 一个简单的 rolling truncation（`messages.length > 25` 时保留最后 10 条）。这导致了两个核心问题：

1. **短期记忆断片**：rolling truncation 是纯数量阈值，不考虑话题连贯性。一轮 20 条消息的长对话被截断后，agent 对该话题的上下文全部丢失。
2. **中期记忆缺失**：compaction 虽然提取了 facts 和 person updates，但没有"今天群里聊了什么"的结构化话题索引。agent 无法回答"刚才大家在讨论什么"。

---

## 1. 三层记忆模型概览

```
┌─────────────────────────────────────────────────────┐
│  短期记忆 (Working Memory)                           │
│  ├── 载体：LLM 上下文中的 messages[] 数组             │
│  ├── 时间跨度：当前 session（分钟级）                  │
│  ├── 管理：智能 Compaction（本文核心设计）              │
│  └── 目标：当前话题连贯 + 近期话题可回溯               │
├─────────────────────────────────────────────────────┤
│  中期记忆 (Episodic + Social Memory)                 │
│  ├── 载体：SQLite 表（topics, person_group_profiles,  │
│  │         group_models, interactions）              │
│  ├── 时间跨度：小时~天级                              │
│  ├── 管理：Recording Pipeline + 主动 Reflection Skill │
│  └── 目标：话题索引 + 群友画像 + 交互模式              │
├─────────────────────────────────────────────────────┤
│  长期记忆 (Semantic / Identity)                       │
│  ├── 载体：SQLite 表（core_facts, person_identities） │
│  ├── 时间跨度：天~永久                                │
│  ├── 管理：Reflection 过程中提炼 + 情感记忆渐进合并     │
│  └── 目标：核心事实、稳定人格、长期关系                 │
└─────────────────────────────────────────────────────┘
```

---

## 2. 短期记忆：智能上下文 Compaction

### 2.1 问题空间

当前的 `messages[]` 是一条无限增长的时间线，唯一的控制手段是 `messages.length > 25` 后的粗暴截断。

| 参数 | 含义 | 当前状态 |
|------|------|---------|
| **模型上下文窗口** | 模型能接受的最大 token 数 | 未追踪 |
| **有效上下文窗口** | 模型在多长的上下文中仍能准确利用早期信息（通常远小于标称值） | 未考虑 |
| **Token 预算** | 分配给对话历史的 token 比例 | 无配置 |

> [!IMPORTANT]
> **有效上下文窗口 ≠ 模型上下文窗口**。例如 Claude Sonnet 4 标称 200K，但信息提取能力在 ~40K 后开始衰减。我们根据**有效窗口期**而非标称值来决定 compaction 时机。

### 2.2 设计方案：分段式上下文管理

将 `messages[]` 分为四个概念区域（仍然是同一个数组）：

```
messages[] 数组结构：
┌──────────────────────────────────────────────────────┐
│ [0] System Prompt (动态注入，每轮更新)                  │
├──────────────────────────────────────────────────────┤
│ [?] Context Briefing (压缩后的上下文摘要)               │
│     "之前的对话中，你和 alice 讨论了东京旅行..."          │
│     "群里今天的热门话题：新番讨论、美食推荐..."            │
├──────────────────────────────────────────────────────┤
│     Recent History (最近 N 条完整对话)                   │
│     保留完整的 user/assistant 交互                      │
│     确保当前话题的对话流不断裂                           │
├──────────────────────────────────────────────────────┤
│     Active Turn (当前正在进行的交互)                     │
│     新事件 / 新的 LLM response / 执行结果               │
└──────────────────────────────────────────────────────┘
```

### 2.3 Compaction 触发策略

**核心原则：保持尽可能长的连续对话上下文**。自然语言话题长度一般不超过 10K token，因此大多数情况下不需要触发 compaction。仅当 token 估算值接近有效上下文窗口上限时才使用 cheap model 做压缩。

基于 **token 估算**触发：

```typescript
interface ContextBudget {
  /** 模型的有效上下文窗口（token 数），推荐默认值 + config 可覆盖 */
  effectiveContextWindow: number;
  /** 分配给 system prompt 的预算比例 */
  systemPromptRatio: number;    // 默认 0.20
  /** 分配给 context briefing 的预算比例 */
  briefingRatio: number;         // 默认 0.15
  /** 分配给 recent history 的预算比例 */
  recentHistoryRatio: number;    // 默认 0.50
  /** 预留给当前轮次 output 的预算（固定值） */
  outputReserve: number;         // 默认 4096
}
```

**Token 计算**：使用 `js-tiktoken`（纯 JS 的 BPE tokenizer）进行精确计算，无需字符数估算：

```typescript
import { encodingForModel } from 'js-tiktoken';

const encoder = encodingForModel('gpt-4o');  // BPE encoder，兼容主流模型

function countTokens(text: string): number {
  return encoder.encode(text).length;
}

function countMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + countTokens(m.content), 0);
}
```

> [!NOTE]
> `js-tiktoken` 是纯 JavaScript 实现，无 WASM 依赖，适合 Node.js 环境。不同模型的 tokenizer 差异在 compaction 场景下可忽略（误差 < 5%），统一使用 `gpt-4o` 的 BPE 编码即可。

**触发条件**：`countMessagesTokens(全部可见messages) > effectiveContextWindow * 0.85` 时才触发 compaction。在此之前，**完整保留所有消息**不做任何压缩。

### 2.4 Compaction 执行流程

触发后调用 **cheap model**（如 Gemini Flash）生成 Context Briefing：

```
Step 1: 划分消息区域
├── pinnedMessages: system prompt（始终保留）
├── briefingSlot: 当前的 context briefing（如果有）
├── candidateMessages: 可能被压缩的历史消息
└── recentMessages: 最近 K 条消息（当前活跃话题，受保护）

Step 2: 确定保护范围
├── 检测当前活跃话题（通过 cheap model 分析最近消息的话题线程）
├── 向前扫描 candidateMessages，标记"与活跃话题相关"的消息
└── 被标记的消息也进入保护范围

Step 3: 压缩未保护的消息（调用 cheap model）
├── 将未保护的 candidateMessages 提取内容
├── 调用 cheap model 生成 Context Briefing（结构化摘要）
└── 格式：
    "## 之前的对话摘要
     - [话题A] 你和 alice, bob 讨论了 XXX，结论是 YYY
     - [话题B] charlie 提到了 ZZZ，你回复了 WWW
     ## 关键事实
     - alice 下周要去东京旅行
     - bob 推荐了一家日料店
     ## 活跃待续话题
     - 正在和 alice 讨论旅行路线（context 仍在）"

Step 4: 重组 messages[]
├── [0] System Prompt
├── [1] Context Briefing（新生成的，替换旧的）
├── [2..] recentMessages（完整保留）
└── 总 token 应在 budget 范围内
```

### 2.5 话题连贯性保护

> [!IMPORTANT]
> 这是区别于简单"保留最后 N 条"的核心设计。

**问题场景**：群里先讨论了"新番推荐"（10条消息），然后插入了一段"买外卖"的闲聊（8条消息），然后有人突然说"回到刚才的新番话题"。如果按条数截断，"新番推荐"的上下文丢了。

**解决方案**：使用 **cheap model + reply 链**做话题标注。

```typescript
interface TopicThread {
  /** 话题标识（UUID v4） */
  topicId: string;
  /** 话题标签 */
  label: string;
  /** 最后活跃时间 */
  lastActiveAt: Date;
  /** 关联的消息索引 */
  messageIndices: number[];
  /** 话题状态 */
  status: 'active' | 'paused' | 'closed';
}
```

**话题标注方式**：直接使用 reply 链和上下文信息调用 **cheap model** 进行分析。纯启发式不足以处理激烈讨论中不使用 reply chain 但上下文语境隐含话题信息的场景。

具体方案：
1. 以 `reply_to_message_id` 作为强关联信号（确定性连接）
2. 将近期消息批量（如每 20 条）提交给 cheap model，输出每条消息所属的 topic label
3. 相同 label 的消息归入同一 `TopicThread`

**保护规则**：
1. 最近一条消息所属的话题 → `active`，所有关联消息**受保护**
2. 过去 10 分钟内有活动的话题 → `paused`，完整消息可被压缩但 Briefing 保留摘要
3. 超过 10 分钟未活动 → `closed`，压缩为 Briefing 条目

### 2.6 模型能力自适应

提供推荐默认值，允许用户在 `config.yaml` 中覆盖：

```yaml
llm:
  model: "claude-sonnet-4-20250514"
  context_budget:
    # 有效上下文窗口（token 数）。
    # 框架提供推荐默认值，用户可覆盖。
    # 注意：这不是模型的标称上下文窗口，
    # 而是模型能有效利用信息的实际范围。
    effective_window: 32000   # 用户覆盖值（可选）
    history_ratio: 0.65       # 用户覆盖值（可选）
    min_recent_messages: 6
    max_briefing_tokens: 3000

# 推荐默认值（内置在代码中，用户无需配置）
# "claude-sonnet-4":   effective_window = 32000
# "gpt-4o":            effective_window = 24000
# "gpt-4o-mini":       effective_window = 12000
# "gemini-2.0-flash":  effective_window = 16000
```

**Model Router 集成（Phase 6.7）**：切换模型时自动调整 `ContextBudget`。切换到更小模型时可能立即触发额外 compaction。

### 2.7 与现有代码的关系

| 现有代码 | 变更 |
|---------|------|
| `main.ts` L404-417：rolling truncation | **替换**为新的 compaction 逻辑 |
| `compaction.ts`：post-session LLM 提取 | **保留**，输出目标改为 Memory V2 表 |
| `session-runner.ts` L154-156：scope 过滤 | **保留**，过滤后再做 token budget 检查 |
| `llm.ts` `ChatMessage.scope` | **保留** |

---

## 3. 中期记忆：Episodic + Social Memory

### 3.1 数据模型

#### 话题节点 (TopicNode)

> [!IMPORTANT]
> TopicNode 是话题的**持久化形式**，存储在 SQLite `topics` 表中，供 `recall()` 和 `browseHistory()` 检索。与之对应，`pipeline/types.ts` 中的 `Topic` 是话题的**运行时形式**，存在于 TopicRegistry 内存中，驱动实时决策（状态机、Triage、Engaged 对话模式）。两者通过 `pipelineTopicId` 关联。详见 [Section 3.6](#36-话题生命周期从实时到持久)。

```typescript
interface TopicNode {
  id: string;                    // UUID v4（持久化主键）
  pipelineTopicId?: string;      // 对应 Pipeline TopicRegistry 的运行时 ID
  chatId: string;                // 所属群组
  label: string;                 // 话题标签（如 "新番推荐"，LLM 生成）
  summary: string;               // 话题摘要（1-3句话，来自 Recording Pipeline Step 2）
  keyPoints: string[];           // 关键要点（来自 Recording Pipeline Step 2）
  participants: string[];        // 参与者 userId 列表
  messageRange: {                // 原始消息范围（便于用 message_log 回溯）
    firstMessageId: number;
    lastMessageId: number;
    count: number;
  };
  startedAt: string;             // 话题开始时间
  endedAt: string | null;        // 话题结束时间（null=仍在进行）
  sentiment: 'positive' | 'neutral' | 'negative' | 'mixed';
  relatedTopicIds: string[];     // 关联话题（话题演变链）
  keywords: string[];            // 关键词（与 Pipeline Topic.keywords 共享）
  wasEngaged: boolean;           // 该话题是否曾被 Agent 介入
  interventionCount: number;     // Agent 介入次数
  embedding?: Float32Array;      // 向量表示（用于语义检索，Phase M4）
  createdAt: string;
  updatedAt: string;
}
```

#### 个体画像：双层模型

> [!IMPORTANT]
> 个体画像拆分为**全局身份**和**群内画像**两层。同一个人在不同群的行为可能完全不同（如工作群 vs 兴趣群），但某些事实（如"下周去东京"）是跨群共享的。

#### PersonIdentity（全局，跨群共享）

```typescript
interface PersonIdentity {
  userId: string;                // 主键（Telegram userId）
  
  // ─── 基础信息（跨群共享） ───
  displayName: string;           // 最常用的名字
  aliases: string[];             // 所有已知昵称/曾用名
  
  // ─── 跨群共享的事实 ───
  // 通过 core_facts 表关联（subject = userId），这里不重复存储
  
  // ─── 活跃度 ───
  totalMessageCount: number;     // 跨群总消息数
  lastSeenAt: string;
  firstSeenAt: string;
  updatedAt: string;
}
```

#### PersonGroupProfile（每群独立）

```typescript
interface PersonGroupProfile {
  userId: string;                // 联合主键
  chatId: string;                // 联合主键
  
  // ─── 邓巴分层（每群独立，由 Reflection 显式更新） ───
  dunbarTier: 1 | 2 | 3 | 4;    // 1=核心<=15, 2=熟悉<=50, 3=认识<=150, 4=陌生
  dunbarReason: string;          // LLM 给出的分层理由
  
  // ─── 群内画像（每群不同） ───
  traits: string[];              // 在这个群的性格表现
  interests: string[];           // 在这个群的兴趣话题
  communicationStyle: string;    // 在这个群的说话风格
  
  // ─── 关系信息（每群独立） ───
  relationToAgent: string;       // 在这个群与 agent 的关系描述
  
  // ─── 情感交互历史（渐进合并） ───
  // 详见 3.2 情感记忆合并机制
  recentEpisodes: InteractionEpisode[];   // 近 7 天的详细交互
  mergedMemory: MergedMemory[];           // 更早的合并后记忆
  
  // ─── 群内活跃度（程序化更新，非 LLM） ───
  messageCount: number;          // 此群的消息数
  lastSeenAt: string;
  activeHours: number[];         // 活跃时段分布（0-23），由代码统计更新
  
  firstSeenAt: string;
  updatedAt: string;
}
```

#### 邓巴分层更新逻辑

> [!IMPORTANT]
> 邓巴分层由 LLM 在 Reflection 过程中显式更新，而不是纯算法计算。

Reflection Skill 的 LLM prompt 中包含以下指引：

```
对于每个近期活跃的用户，请评估其邓巴分层是否需要调整。
考虑因素：
- 最近 7 天的交互频率和深度
- 是否主动发起对话 / “按照形式”
- 情感交互的双向性（只是 agent 在回复，还是真正的双向交流）
- 话题深度（闲聊 vs 深入讨论）

分层规则（上限由 config.yaml 可自定义）：
- Tier 1 (核心): 高频深度互动，主动发起多
- Tier 2 (熟悉): 经常互动，偶尔深入讨论
- Tier 3 (认识): 偶尔互动，主要是群聊中见过
- Tier 4 (陌生): 很少互动或刚加入

请给出调整理由（dunbarReason），例如：
"最近一周 alice 每天都主动找我聊天，话题从动漫到旅行都有，
从 Tier 3 调整为 Tier 2"
```

**邓巴分层上限配置**（`config.yaml`）：

```yaml
memory:
  dunbar_limits:
    tier_1: 15    # 核心圈
    tier_2: 50    # 熟悉圈
    tier_3: 150   # 认识圈
    # tier_4 无上限
```

**量化信号辅助（非 LLM，代码统计）**：Reflection Skill 在调用 LLM 前，会先用代码计算每个用户的近期交互统计（消息数、主动发起率、交互天数等），作为 LLM 评估的引用数据注入 prompt。

#### 用户画像精度与邓巴分层挂钩

> [!IMPORTANT]
> 邓巴分层直接影响画像的精度和存储长度。Tier 越高（越核心），画像越详细。

Reflection Skill 根据用户的 `dunbarTier` 调整画像更新的粒度：

| Tier | 画像精度 | traits 上限 | interests 上限 | facts 保留 | recentEpisodes 保留 |
|------|---------|-----------|-------------|---------|------------------|
| 1 (核心) | 精细 | 10 | 15 | 全部 | 14 天 |
| 2 (熟悉) | 详细 | 6 | 10 | 全部 | 7 天 |
| 3 (认识) | 简略 | 3 | 5 | 只保留重要的 | 3 天 |
| 4 (陌生) | 最简 | 1 | 2 | 只保留核心的 | 1 天 |

这意味着：
- Tier 1 用户的 Reflection prompt 会要求 LLM 提供更多维度的画像更新（包括微妙的性格变化、兴趣演变等）
- Tier 4 用户只保留最基本的信息（一个 trait、两个 interest），节省存储和 LLM 开销
- 当用户的 Tier 升级时，下次 Reflection 会自动填充更多画像细节

#### 活跃时段更新机制

`activeHours` 由代码统计更新，不使用 LLM：

```typescript
// 每次收到该用户的消息时，程序化更新时段分布
function updateActiveHours(profile: PersonGroupProfile, messageTimestamp: Date) {
  const hour = messageTimestamp.getHours();
  // activeHours[hour] 累加计数，用于分析该用户习惯活跃的时间段
  profile.activeHours[hour] = (profile.activeHours[hour] || 0) + 1;
  profile.messageCount += 1;
  profile.lastSeenAt = messageTimestamp.toISOString();
}
```

同样，`messageCount` 和 `lastSeenAt` 也是由代码统计更新，不依赖 LLM。

#### 跨群知识互通

- **事实层面**：跨群共享的事实存储在 `core_facts` 表中（`subject = userId`）。任何群的 Reflection 中发现的通用事实写入 `core_facts`，所有群可检索。
- **画像层面**：`PersonGroupProfile` 每群独立。A 群活跃不影响 B 群的 `dunbarTier`。
- **Agent 可主动关联**：`recall({ userId: "alice" })` 获取 alice 在所有群的画像和通用事实。Agent 可以明确引用跨群信息（如“我在隔壁群听说你要去东京”），模拟人类社交中自然的信息引用行为。

#### 群组画像 (GroupModel)

```typescript
interface GroupModel {
  chatId: string;                // 主键
  chatTitle: string;
  
  // ─── 群组特征 ───
  description: string;           // 群组描述/定位
  dominantLanguage: string;      // 主要语言
  communicationNorms: string[];  // 交流规范（如"这个群经常发梗图"）
  
  // ─── 活跃度分析 ───
  activeMembers: number;         // 活跃成员数
  avgMessagesPerDay: number;     // 日均消息量
  peakHours: number[];           // 活跃高峰时段
  
  // ─── Agent 在群中的定位 ───
  agentRole: string;             // agent 在群中扮演的角色
  engagementLevel: 'high' | 'medium' | 'low';
  recentFeedback: string;        // 最近收到的反馈总结
  
  // ─── 话题偏好 ───
  hotTopics: string[];           // 近期热门话题
  tabooTopics: string[];         // 不宜讨论的话题
  
  updatedAt: string;
}
```

### 3.2 情感记忆渐进合并

> [!IMPORTANT]
> 模拟人类记忆的自然衰减——近期交互记得很详细，时间越久越只剩模糊印象和关键事件。

#### 数据结构

```typescript
/** 近期的详细交互记录（7 天内保留） */
interface InteractionEpisode {
  id: string;                    // UUID v4
  date: string;                  // ISO date
  topicId: string | null;        // 关联话题
  type: 'agent_replied' | 'agent_mentioned' | 'direct_message' | 'reaction';
  summary: string;               // 详细描述："alice 问了我东京旅行建议，我推荐了浅草寺"
  sentiment: 'positive' | 'neutral' | 'negative';
  significance: number;          // 0-1，重要程度
}

/** 合并后的记忆（周/月/季度/年粒度，模拟人类记忆渐进模糊） */
interface MergedMemory {
  periodStart: string;           // 时期开始 "2026-01"
  periodEnd: string;             // 时期结束 "2026-01"
  granularity: 'week' | 'month' | 'quarter' | 'year';
  overallSentiment: 'positive' | 'neutral' | 'negative' | 'mixed';
  interactionCount: number;      // 该时期的交互次数
  /** 只保留重要事件（significance > 0.7）的摘要 */
  highlights: string[];
  /** 关系变化描述 */
  relationshipTrend: string;     // 如 "从陌生变得熟悉，开始主动找我聊天"
}
```

#### 合并策略

```
时间轴：
[每次交互] → InteractionEpisode（详细）
     │
     │ 7 天后
     ▼
[按周合并] → MergedMemory(granularity='week')
     │         保留 significance > 0.7 的 highlights
     │         其余合并为 interactionCount + overallSentiment
     │
     │ 30 天后
     ▼
[按月合并] → MergedMemory(granularity='month')
     │         多个周合并为月
     │
     │ 90 天后
     ▼
[按季度合并] → MergedMemory(granularity='quarter')
     │
     │ 365 天后
     ▼
[按年合并] → MergedMemory(granularity='year')
              只剩 "2025年和这个人互动了 150 次，
              整体关系正面，有几件印象深刻的事：..."
```

合并操作在 **Reflection Skill** 触发时执行（见 3.3），不需要单独的定时任务。

> [!IMPORTANT]
> 每一层合并都使用 **cheap model** 对事件进行综合分析，而非简单机械分组。LLM 负责：
> - 综合判断 `overallSentiment`（而非简单多数投票）
> - 提炼真正值得记忆的 `highlights`（而非仅按 significance 阈值过滤）
> - 生成有画面感的 `relationshipTrend` 描述（如"从陌生变得熟悉，开始开玩笑"）
>
> LLM 调用失败时自动回退到规则合并，保证系统健壮性。合并分析 prompt 位于 `system-prompts/merge-episodes-system.md`。

### 3.3 中期记忆更新机制：Reflection Skill

> [!WARNING]
> 不再叫"Daily Digest"——因为触发时机不是自然日，而是基于群聊活动模式。

#### 触发时机：活动感知式

| 触发方式 | 条件 | 说明 |
|---------|------|------|
| **冷场触发** | 群聊静默超过 `reflection_threshold`（默认 2h） | 群冷场了 → agent 利用空闲时间"反思"最近的对话 |
| **作息触发** | 对于持续活跃的群，agent 在 `awake_hours` 范围外触发 | 模拟人类"睡前回顾"，agent 有自己的作息时间 |
| **Agent 主动调用** | Agent 在 CodeAct session 中调用 `memorySkills.reflect()` | 感觉有必要时随时调用 |
| **CLI 手动触发** | `npx tsx src/cli.ts memory reflect --chat <id>` | 调试和运维使用 |

**Agent 作息时间配置**（`config.yaml`）：

```yaml
agent:
  schedule:
    awake_hours: [8, 24]       # 活跃时段：08:00-24:00
    timezone: "Asia/Shanghai"
    
  reflection:
    silence_threshold: 7200    # 冷场阈值（秒），默认 2 小时
    max_interval: 86400        # 最长不反思间隔（秒），默认 24 小时
```

Agent 通过 `runtime.cron` 自己设定定时任务，同时保留主动调用 skill 的能力。

#### Reflection Skill 接口

```typescript
declare const memorySkills: {
  /**
   * 对指定群组进行反思总结
   * 读取上次反思以来的 topics 和 interactions，生成结构化总结
   * 自动更新 person_group_profiles, group_models, core_facts
   * 同时执行情感记忆的渐进合并
   */
  reflect(chatId: string): Promise<{
    reflectedPeriod: { from: string; to: string };
    topicsSummary: Array<{
      label: string;
      summary: string;
      participants: string[];
      sentiment: string;
    }>;
    personUpdates: Array<{
      userId: string;
      chatId: string;
      changes: string;
    }>;
    groupUpdates: string;
    newCoreFacts: string[];
    mergedEpisodes: number;      // 合并了多少条旧交互记录
    insights: string;            // 对未来行为的反思建议
  }>;

  /**
   * 更新某人在某群的画像
   */
  updatePersonProfile(userId: string, chatId: string): Promise<{
    before: Partial<PersonGroupProfile>;
    after: Partial<PersonGroupProfile>;
    changes: string;
  }>;

  /**
   * 统一记忆检索入口
   * 使用向量搜索 + 关键词搜索混合检索
   * 结果超过阈值时调用 cheap model subagent 做深度总结
   */
  recall(query: string, options?: {
    chatId?: string;
    userId?: string;
    daysBack?: number;
    maxResults?: number;
    /** 结果 token 超过此值时启用 cheap model 做总结 */
    deepRecallThreshold?: number;
  }): Promise<{
    topics: TopicNode[];
    facts: string[];
    persons: PersonGroupProfile[];
    /** 如果触发了深度总结，这里包含 cheap model 生成的综合摘要 */
    deepSummary?: string;
  }>;

  /**
   * 消息档案检索（一等模块，详见 Section 5）
   * 话题索引引导 + 模糊搜索 + 上下文窗口 + cheap model 深度阅读
   */
  browseHistory(request: HistoryBrowseRequest): Promise<HistoryBrowseResult>;
};
```

#### Reflection 内部流程

```
1. 查询上次 reflect 的时间戳（存在 group_models.last_reflected_at）
2. 从 topics 表查询该时间段内的所有话题节点
3. 从 interactions 表查询该时间段内的所有交互
4. 调用 cheap model 生成：
   ├── 话题总结
   ├── 每个活跃参与者的画像增量更新
   ├── 群组氛围变化
   └── 值得长期记住的新事实
5. 解析 LLM 输出为结构化数据
6. 写入：
   ├── person_group_profiles: merge 更新
   ├── person_identities: 更新 aliases / displayName（如有变化）
   ├── group_models: merge 更新
   ├── core_facts: 新增跨群共享事实
   └── agent-state: 追加反思记录
7. 执行情感记忆合并：
   ├── 将 > 7 天的 InteractionEpisode 合并为 MergedMemory(week)
   ├── 将 > 30 天的 week 合并为 month
   └── 依此类推
```

### 3.4 SQLite 表结构

```sql
-- 话题节点（持久化形式，由 Recording Pipeline flush Step 4 写入）
CREATE TABLE topics (
  id TEXT PRIMARY KEY,            -- UUID v4
  pipeline_topic_id TEXT,         -- 对应 Pipeline TopicRegistry 的运行时 ID（upsert 条件）
  chat_id TEXT NOT NULL,
  label TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  key_points TEXT NOT NULL DEFAULT '[]',
  participants TEXT NOT NULL DEFAULT '[]',
  keywords TEXT NOT NULL DEFAULT '[]',  -- 关键词（来自 Pipeline Topic.keywords）
  first_message_id INTEGER,
  last_message_id INTEGER,
  message_count INTEGER DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  sentiment TEXT DEFAULT 'neutral',
  related_topic_ids TEXT DEFAULT '[]',
  was_engaged BOOLEAN DEFAULT 0,  -- Agent 是否曾介入该话题
  intervention_count INTEGER DEFAULT 0,  -- Agent 介入次数
  embedding BLOB,                 -- 向量表示（Phase M4: sqlite-vec + text-embedding-3-small）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_topics_chat_date ON topics(chat_id, started_at);
CREATE INDEX idx_topics_pipeline_id ON topics(pipeline_topic_id);

-- 个体身份（全局，跨群）
CREATE TABLE person_identities (
  user_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  aliases TEXT NOT NULL DEFAULT '[]',
  total_message_count INTEGER DEFAULT 0,
  last_seen_at TEXT,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 个体群内画像（每群独立）
CREATE TABLE person_group_profiles (
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  dunbar_tier INTEGER NOT NULL DEFAULT 4,
  dunbar_reason TEXT DEFAULT '',
  traits TEXT NOT NULL DEFAULT '[]',
  interests TEXT NOT NULL DEFAULT '[]',
  communication_style TEXT DEFAULT '',
  relation_to_agent TEXT DEFAULT '',
  recent_episodes TEXT DEFAULT '[]',     -- JSON: InteractionEpisode[]
  merged_memory TEXT DEFAULT '[]',       -- JSON: MergedMemory[]
  message_count INTEGER DEFAULT 0,
  last_seen_at TEXT,
  active_hours TEXT DEFAULT '[]',
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, chat_id)
);
CREATE INDEX idx_pgp_chat ON person_group_profiles(chat_id);

-- 群组画像
CREATE TABLE group_models (
  chat_id TEXT PRIMARY KEY,
  chat_title TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  dominant_language TEXT DEFAULT 'zh',
  communication_norms TEXT DEFAULT '[]',
  active_members INTEGER DEFAULT 0,
  avg_messages_per_day REAL DEFAULT 0,
  peak_hours TEXT DEFAULT '[]',
  agent_role TEXT DEFAULT '',
  engagement_level TEXT DEFAULT 'medium',
  recent_feedback TEXT DEFAULT '',
  hot_topics TEXT DEFAULT '[]',
  taboo_topics TEXT DEFAULT '[]',
  last_reflected_at TEXT,          -- 上次反思时间
  updated_at TEXT NOT NULL
);

-- 交互日志（被 Reflection 消费后合并）
CREATE TABLE interactions (
  id TEXT PRIMARY KEY,             -- UUID v4
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  topic_id TEXT,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  sentiment TEXT DEFAULT 'neutral',
  significance REAL DEFAULT 0.5,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_interactions_user_chat ON interactions(user_id, chat_id, created_at);

-- 核心事实（长期记忆，跨群共享）
-- category 枚举:
--   biographical  个人信息
--   preference    喜好
--   anecdote      趣事/黑历史（永不过期、永不在合并中删除）
--   opinion       观点
--   plan          计划（带 expires_at）
--   relationship  人际关系
--   general       通用事实
CREATE TABLE core_facts (
  id TEXT PRIMARY KEY,             -- UUID v4
  subject TEXT NOT NULL,           -- userId / chatId / 通用主题
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  confidence REAL DEFAULT 1.0,
  source TEXT,                     -- topic_id 或 interaction_id
  embedding BLOB,                  -- 向量表示（sqlite-vec，由 text-embedding-3-small 等 embedding API 生成）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT                  -- 时效性事实的过期时间
);
CREATE INDEX idx_facts_subject ON core_facts(subject);
CREATE INDEX idx_facts_category ON core_facts(category);
```

### 3.5 Compaction 与 Recording Pipeline 的职责划分

> [!IMPORTANT]
> Recording Pipeline 是 `topics` 表的**主要写入者**（每次 flush 都 upsert）。Compaction **不再创建话题节点**，而是聚焦于提炼 Agent session 中产生的事实和画像更新。

| 维度 | Recording Pipeline（flush Step 4） | Compaction（session 结束后） |
|------|-----------------------------------|---------------------------|
| 触发时机 | 每次 flush（50 条 / 2 分钟） | 每个 CodeAct session 结束后 |
| 话题来源 | LLM 聚类生成，**所有**群聊消息 | 仅 Agent 参与的 session 消息 |
| 写入 `topics` 表 | **upsert**（主写入者） | 仅补充已有 topic 的 `sentiment` |
| 写入 `core_facts` 表 | ✗ 不写 | ✅ 提炼新事实（主写入者） |
| 写入 `person_*` 表 | 程序化字段（messageCount, lastSeenAt） | LLM 生成的画像更新（traits, interests） |
| 写入 `message_log` 表 | ✅ 批量写入原始消息 | ✗ 不写 |

**Compaction 改造后的流程**：
1. 查找 session 时间范围内的已有 topics（通过 `started_at`/`ended_at` 重叠）
2. 为匹配的 topics 补充 `sentiment`（如果 Recording Pipeline 未标注）
3. 从 session 对话中提炼 `core_facts`（分类为 `FactCategory`）
4. 更新 `person_identities` 和 `person_group_profiles`（LLM 画像更新）

输出目标映射（保留旧字段迁移参考）：

| 原输出 | 新输出 |
|--------|--------|
| `memories` 表 | `core_facts` 表 |
| `person_profiles` 表 | `person_identities` + `person_group_profiles` |
| `conversation_log` 表 | 不再写入（由 Recording Pipeline 负责） |
| `todos` 表 | 保留不变 |

### 3.6 话题生命周期：从实时到持久

Pipeline Topic（内存）和 TopicNode（SQLite）不是两个独立的数据结构，而是**同一个话题在不同生命阶段的表现形式**。

```
消息到达 → Recording Pipeline 缓冲
    │
    ▼ flush 触发（50条 / 2分钟静默）
Pipeline Topic 创建/更新（内存 TopicRegistry）
    │
    ├── flush Step 2: LLM 生成 summary + keyPoints
    │
    ▼ flush Step 4
TopicNode upsert 到 SQLite topics 表
    │
    ├── Pipeline Topic 继续在内存中驱动决策
    │   (ACTIVE → TRIAGING → ENGAGED → COOLDOWN → ...)
    │
    ▼ ARCHIVED (2h 无活动)
Pipeline Topic 从内存删除
TopicNode 保留在 SQLite，永久可被 recall() / browseHistory() 检索
```

**写入时机**：
- **增量 upsert**：每次 Recording Pipeline flush 时，用 `pipeline_topic_id` 作为 upsert 条件，将当前 summary/keyPoints/participants/messageRange 写入 topics 表
- **终态标记**：话题 ARCHIVED 时，标记 `ended_at`，此后不再更新

**字段来源映射**：

| TopicNode 字段 | 来源 |
|---------------|------|
| `summary`, `keyPoints` | Recording Pipeline Step 2 LLM 输出（每次 flush 覆盖） |
| `keywords` | Pipeline Topic 的 `keywords`（LLM 话题聚类时生成） |
| `participants` | Pipeline Topic 的 `participantIds`（程序化累积） |
| `messageRange` | Pipeline Topic 的 `messageIds` 首尾 + `messageCount` |
| `wasEngaged`, `interventionCount` | Pipeline Topic 的状态机和对话记录 |
| `sentiment` | Compaction 补充 或 Recording Pipeline LLM 标注 |

#### 完整示例：一个话题从诞生到回忆

**群聊「二次元研究所」中讨论京都旅行攻略**

**Step 1：消息到达，Pipeline Topic 诞生**

```
14:00  alice: 有人去过京都岚山吗
14:01  bob: 去过，秋天红叶超美
14:02  carol: 从大阪过去要多久啊
14:03  alice: 对，交通是不是很复杂
...（共 18 条消息）
14:15  [2 分钟静默] → Recording Pipeline flush 触发
```

fush Step 1-3 完成后，此时**只有 Pipeline Topic 存在于内存中**：

```typescript
// TopicRegistry 内存中的 Pipeline Topic
{
  id: "topic_m3k_0001",              // 短 ID，运行时自增
  chatId: -100123456,                // number 类型
  label: "京都岚山旅行攻略",
  keywords: ["京都", "岚山", "交通"],
  participantIds: Set { 111, 222, 333 },
  messageIds: [501, 502, ..., 518],
  state: "ACTIVE",                   // 10 态状态机
  recentContext: "alice: 有人去过...\nbob: 去过...",
  createdAt: 1709647200000,          // 毫秒时间戳
  lastActivityAt: 1709648100000,
  messageCount: 18,
  turnCount: 0,                      // ENGAGED 专属字段（暂时空着）
  pendingMessages: [],
  exitSignals: [],
  interventionCount: 0,
}
```

flush Step 4 **同时 upsert 到 SQLite**，TopicNode 诞生：

```sql
INSERT INTO topics (id, pipeline_topic_id, chat_id, label, summary, key_points,
                    participants, keywords, first_message_id, last_message_id,
                    message_count, started_at, ended_at, sentiment,
                    was_engaged, intervention_count, created_at, updated_at)
VALUES (
  'a1b2c3d4-...',                     -- UUID 持久化主键
  'topic_m3k_0001',                   -- 指回 Pipeline Topic
  '-100123456',                       -- string 类型
  '京都岚山旅行攻略',
  'alice 想去岚山，大家在讨论交通方式和景点',
  '["讨论从大阪到岚山的交通","红叶季节推荐"]',
  '["111","222","333"]',
  '["京都","岚山","交通"]',
  501, 518, 18,
  '2026-03-05T14:00:00Z', NULL,       -- ended_at=NULL，话题仍在进行
  'neutral',
  0, 0,                               -- 还没被 Agent 介入
  '2026-03-05T14:15:00Z', '2026-03-05T14:15:00Z'
);
```

此时系统中同一个话题有**两份表示**：

| | Pipeline Topic（内存） | TopicNode（SQLite） |
|---|---|---|
| **用途** | FastRouter 路由消息、Triage 判断要不要介入 | `recall("京都")` 能搜到、`browseHistory` 能定位 |
| **活跃** | ✅ 正在被状态机驱动 | ✅ 已可被检索 |

**Step 2：Triage 通过，Agent 介入**

```
14:16  Triage: confidence=0.78, KNOWLEDGE_GAP → ENGAGED
14:18  Agent 回复："坐阪急到桂站转岚电最快，大概50分钟"
14:19  alice: "哦哦谢谢！"
14:20  carol: "竹林早上去 get✓"
```

Pipeline Topic 状态变更（只在内存）：

```typescript
{
  state: "ENGAGED",                   // ACTIVE→TRIAGING→PRELOADING→ENGAGED
  turnCount: 1,
  lastAgentReplyAt: 1709648280000,
  primaryInterlocutor: 111,           // alice
  pendingMessages: [msg_alice, msg_carol],
  interventionCount: 1,
}
```

> TopicNode 此时**不更新**——要等下一次 Recording Pipeline flush 才 upsert。

**Step 3：对话结束，再次 flush，TopicNode 增量更新**

```
14:21  Agent 第 2 轮回复
14:23  bob: "对对 岚电不贵"
14:25  话题自然结束 → ENGAGED → EXITING → COOLDOWN
14:25-15:00 群里讨论其他话题（共 35 条新消息缓冲）
15:02  [2 分钟静默] → Recording Pipeline 再次 flush
```

flush Step 4 再次 upsert，更新摘要和介入信息：

```sql
UPDATE topics SET
  summary = 'alice 想去京都岚山，Agent 回答了交通方式（阪急转岚电），
             大家补充了票价和竹林推荐',
  key_points = '["阪急转岚电约50分钟","关西周游券可用阪急","竹林早上人少推荐"]',
  last_message_id = 536,
  message_count = 36,
  participants = '["111","222","333","444"]',
  was_engaged = 1,                    -- Agent 参与过
  intervention_count = 2,             -- 回复了 2 轮
  updated_at = '2026-03-05T15:02:00Z'
WHERE pipeline_topic_id = 'topic_m3k_0001';
```

**Step 4：归档——Pipeline Topic 消亡，TopicNode 永存**

```
17:02  距最后活动 2h → TopicRegistry.cleanup()
       STALE → ARCHIVED → 最终 upsert
```

```sql
UPDATE topics SET
  ended_at = '2026-03-05T15:02:00Z',
  sentiment = 'positive',
  updated_at = '2026-03-05T17:02:00Z'
WHERE pipeline_topic_id = 'topic_m3k_0001';
```

次日 17:02 Pipeline Topic 从内存 Map 中删除。**TopicNode 永久保存在 SQLite。**

**Step 5：三天后——TopicNode 被回忆**

```
3月8日 20:00  charlie: @Agent 之前谁推荐过岚山交通方式来着？
```

Agent 调用 `recall()`：

```typescript
const result = await memory.recall("岚山 交通", { chatId: "-100123456", daysBack: 7 });
// → 命中 TopicNode:
//   label: "京都岚山旅行攻略"
//   summary: "alice 想去京都岚山，Agent 回答了交通方式..."
//   wasEngaged: true → Agent 知道自己参与过！

// 需要原始消息？调用 browseHistory
const detail = await memory.browseHistory({
  intent: "之前推荐的岚山交通方式",
  hints: { topicId: "a1b2c3d4-..." },
});
// → 通过 messageRange(501-536) 从 message_log 拉取原始对话
```

**总结：生命周期时间轴**

```
时间轴  14:00    14:15    14:18    15:02    17:02    次日      3天后
        │        │        │        │        │        │         │
Pipeline│ 创建    │        │ ENGAGED │        │ARCHIVED│ 删除    │
Topic   │ ACTIVE │ flush  │ 介入    │ flush  │ 终态   │ 从内存  │
(内存)  ●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━●         │
        │        │        │        │        │                  │
TopicNode        │ INSERT │        │ UPDATE │ UPDATE │         │ recall()
(SQLite)│        ●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━●
                 │ 首次   │        │ 更新   │ended_at│         │ 命中
```

Pipeline Topic 是**蜉蝣**——活几小时后消失。TopicNode 是**化石**——Pipeline Topic 留下的持久化印记，永久可检索。

---

## 4. 统一检索入口 `recall()`

所有对中期/长期记忆的查询通过 `recall()` 入口，**以 embedding 向量搜索为核心**。

### 4.1 Embedding 策略

**写入时嵌入，查询时对比**：

| 写入时机 | 嵌入对象 | 存储位置 |
|---------|---------|----------|
| Recording Pipeline 完成话题标注 | `topic.label + summary + keyPoints` 拼接 | `topics.embedding` |
| Reflection / Compaction 提炼事实 | `core_fact.content` | `core_facts.embedding` |

- **Embedding 模型**：`text-embedding-3-small`（OpenAI），维度 1536，成本极低（~$0.02/1M tokens）
- **向量存储**：`sqlite-vec` 扩展（SQLite 原生向量搜索），Memory V2 初版即引入
- **批量嵌入**：Recording Pipeline 和 Reflection 过程中批量调用 embedding API，不在查询热路径上嵌入历史数据

### 4.2 事实分类 (FactCategory)

```typescript
type FactCategory =
  | 'biographical'    // 个人信息（"alice 是前端程序员"）
  | 'preference'      // 喜好（"bob 喜欢抹茶拿铁"）
  | 'anecdote'        // 趣事/黑历史（"charlie 把测试数据推到 prod 炸了"）
  | 'opinion'         // 观点（"alice 觉得 Rust 比 Go 好"）
  | 'plan'            // 计划（"alice 下周去东京"，带 expires_at）
  | 'relationship'    // 人际关系（"alice 和 bob 是同事"）
  | 'general';        // 通用事实
```

> [!TIP]
> `anecdote` 类型的事实在 Reflection 合并时**永不过期、永不删除**。Reflection Skill 的 LLM prompt 中会特别要求识别和标注趣事，这是 agent 能翻黑历史的关键。

### 4.3 RecallOptions 与 RecallResult

```typescript
interface RecallOptions {
  chatId?: string;              // 限定群组
  userId?: string;              // 限定用户
  daysBack?: number;            // 时间范围
  maxResults?: number;          // 最大结果数
  /** 按事实类别过滤（如只要趣事） */
  categories?: FactCategory[];
  /** 结果 token 超过此值时启用 cheap model 深度总结 */
  deepRecallThreshold?: number; // 默认 3000 tokens
}

interface RecallResult {
  topics: TopicNode[];
  facts: Array<{
    content: string;
    category: FactCategory;
    subject: string;
    confidence: number;
  }>;
  persons: PersonGroupProfile[];
  /** 如果触发了深度总结，包含 cheap model 综合摘要 */
  deepSummary?: string;
}
```

### 4.4 recall() 实现流程

```typescript
async function recall(query: string, options?: RecallOptions): Promise<RecallResult> {
  // Step 1: 生成查询向量
  const queryEmbedding = await embed(query);  // text-embedding-3-small

  // Step 2: 向量相似度搜索（sqlite-vec，主检索路径）
  const topicHits = vectorSearchTopics(queryEmbedding, {
    chatId: options?.chatId,
    daysBack: options?.daysBack,
    limit: options?.maxResults ?? 10,
  });
  const factHits = vectorSearchFacts(queryEmbedding, {
    subject: options?.userId,
    categories: options?.categories,  // 按 category 过滤
    limit: options?.maxResults ?? 20,
  });

  // Step 3: 关键词精确匹配补充（FTS5，捕捉向量遗漏的精确命中）
  const keywordTopics = ftsSearchTopics(query, options);
  const keywordFacts = ftsSearchFacts(query, options);

  // Step 4: 关联 PersonGroupProfile
  const personHits = searchPersonProfiles(options?.userId, options?.chatId);

  // Step 5: 合并去重 + 按相似度排序
  const merged = mergeAndDedup(
    topicHits, factHits, keywordTopics, keywordFacts, personHits
  );

  // Step 6: 深度总结判断（使用 BPE 精确计算 token 数）
  const totalTokens = countTokens(JSON.stringify(merged));
  const threshold = options?.deepRecallThreshold
    ?? config.memory?.deep_recall_threshold  // config.yaml 可自定义
    ?? 3000;
  if (totalTokens > threshold) {
    // 结果太多 -> cheap model subagent 做全量读入 + 针对性总结
    const deepSummary = await cheapModelSummarize(merged, query);
    return { ...trimToTokenBudget(merged), deepSummary };
  }

  return trimToTokenBudget(merged, options?.maxResults ?? 2000);
}
```

---

## 5. 消息档案模块 (Message Archive)

> [!IMPORTANT]
> 这是一等记忆模块。与 `recall()` 的语义检索不同，消息档案模拟的是人类“翻聊天记录”的行为——通过模糊的记忆线索定位到某个时间段，然后完整阅读那段对话。

### 5.1 为什么需要消息档案

`recall()` 基于向量搜索，返回的是主题/事实的**摘要**。但很多时候 agent 需要的不是摘要，而是**原始对话上下文**：

| 场景 | recall() 能做到 | 消息档案能做到 |
|------|---------|----------|
| "上次推荐的网站叫什么" | ✘ 摘要中可能没记录网站名 | ✔ 读原始消息找到精确名称 |
| "谁说过要去京都" | ✔ 向量搜索命中事实 | ✔ 也能找到，且带上下文 |
| "大概两天前 alice 和 bob 在讨论什么" | ✘ 时间+人物的模糊查询 | ✔ 定位时间段，读完整对话 |
| "上次讨论新番时的具体对话" | ✘ 只有摘要 | ✔ 返回原始消息流 |

### 5.2 消息存储

原始消息存储在 `message_log` 表中（从 Telegram 接收的所有消息的完整副本）：

```sql
CREATE TABLE message_log (
  message_id INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  reply_to_message_id INTEGER,
  timestamp TEXT NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX idx_msglog_chat_time ON message_log(chat_id, timestamp);
CREATE INDEX idx_msglog_user ON message_log(user_id, timestamp);
```

**消息写入时机**：Recording Pipeline 在每次 flush 时**批量写入**。

虽然存在 2 分钟的缓冲延迟，但 `browseHistory()` 的使用场景（回忆过去的对话）不需要实时性。对于正在进行的对话，Pipeline Topic 的 `recentContext` 和 Context Briefing 已提供实时上下文。

> Recording Pipeline flush Step 4 的完整写入列表：
> 1. `message_log` 表 ← 批量写入缓冲区中的原始消息
> 2. `topics` 表 ← upsert 话题节点（见 [Section 3.6](#36-话题生命周期从实时到持久)）
> 3. `person_group_profiles` 表 ← 程序化更新 messageCount, lastSeenAt, activeHours

### 5.3 HistoryBrowseRequest / HistoryBrowseResult

```typescript
interface HistoryBrowseRequest {
  /** 自然语言描述的搜索意图（支持模糊） */
  intent: string;
  // 例如：
  // "找到之前讨论旅行攻略时提到的行程规划网站"
  // "谁说过要去京都吃抹茶"
  // "大概两天前 alice 和 bob 在聊什么"
  // "上次 charlie 出糕是什么情况"

  /** 搜索提示（可选，缩小范围） */
  hints?: {
    chatId?: string;         // 限定群组
    userId?: string;         // 限定发言人
    topicLabel?: string;     // 指定话题标签（会查 topics 表）
    topicId?: string;        // 指定话题 ID
    hoursBack?: number;      // 时间范围（小时）
    daysBack?: number;       // 时间范围（天）
  };

  /** 上下文窗口大小（命中消息前后各复少条） */
  contextWindow?: number;    // 默认 10

  /** 最大结果数 */
  maxSegments?: number;      // 默认 3
}

interface HistoryBrowseResult {
  /** cheap model 生成的针对性回答 */
  answer: string;

  /** 定位到的消息段落 */
  segments: Array<{
    topicLabel: string;         // 所属话题
    timeRange: { from: string; to: string };
    messages: Array<{
      messageId: number;
      userId: string;
      displayName: string;
      text: string;
      timestamp: string;
    }>;
    relevanceScore: number;     // 0-1
  }>;

  /** 总共阅读了多少条消息 */
  messagesRead: number;
}
```

### 5.4 检索流程

```
browseHistory(“谁说过要去京都吃抹茶”)
│
│ Step 1: 解析意图（cheap model 或规则引擎）
│ 输入：intent + hints
│ 输出：结构化查询参数
│   who: null (不确定)
│   what: ["京都", "抹茶"]
│   when: null (不确定)
│   topicHint: null
│
▼ Step 2: 话题索引定位
│ 查询 topics 表：
│   向量搜索 "京都 抹茶" → 命中 topic "旅行美食讨论"
│   获取 messageRange: [msg#120, msg#155]
│   如果 hints 指定了 topicLabel，直接用 topics 表定位
│   如果无命中，退化为时间范围 + 关键词搜索 message_log
│
▼ Step 3: 拉取消息段落
│ 从 message_log 拉取 msg#110 ~ msg#165
│ (命中范围 + 前后 contextWindow 扩展)
│ 包含完整的上下文，而不是单独的命中行
│
▼ Step 4: cheap model 深度阅读
│ 将消息段落完整传给 cheap model
│ prompt: "请阅读以下聊天记录，回答：谁说过要去京都吃抹茶？"
│ cheap model 阅读完整上下文，给出精确回答
│
▼ Step 5: 返回结果
  answer: "alice 在 3月31日讨论旅行美食时提到想去京都吃抹茶，
          当时 bob 推荐了一家叫'中村藤吉'的店"
  segments: [原始消息段落]
```

### 5.5 模糊搜索的关键设计

人类翻聊天记录时，线索通常是模糊的：
- “谁说过” → 可能不确定是谁
- “大概两天前” → 时间模糊
- “那个日料店” → 内容模糊

**意图解析**用 cheap model 将自然语言 intent 转为结构化查询：

```typescript
// cheap model 解析结果
interface ParsedIntent {
  who: string | null;          // 发言人（null = 不确定）
  what: string[];              // 关键词 / 语义线索
  when: {                      // 时间范围（null = 不确定）
    from?: string;
    to?: string;
    fuzzyDescription?: string; // "大概两天前" "上周末"
  } | null;
  topicHint: string | null;    // 可能的话题提示
}
```

**多级定位策略**：

1. **话题索引优先**：先查 `topics` 表（向量搜索 + 时间过滤），定位相关话题的 `messageRange`
2. **用户索引**：如果有 `who`，用 `person_identities.aliases` 解析是哪个 userId，然后用 `message_log.user_id` 过滤
3. **时间索引**：`fuzzyDescription` 由 cheap model 解析为具体时间范围
4. **回退搜索**：如果话题索引无结果，退化为 `message_log` 的 FTS + 时间范围搜索

> [!IMPORTANT]
> **SOTA model 直接调用**：`browseHistory()` 不仅是内部流程——它是作为 CodeAct session 中的一等工具暴露给 SOTA model 的。Agent（SOTA model）在思考过程中可以显式决定调用此工具：
>
> ```typescript
> // Agent 在 CodeAct session 中的思考过程：
> // "我记得之前有人提到过一个抹茶店，让我找一下..."
> const result = await memorySkills.browseHistory({
>   intent: "之前谁提到过一个抹茶商店",
>   hints: { chatId: "-100xxx", daysBack: 7 },
> });
> // SOTA model 拿到 result.answer 和 segments 后自行判断如何使用
> ```
>
> 即：**SOTA model 发起搜索意图 → 系统用 cheap model 做意图解析 + 消息阅读 → 结果返回给 SOTA model**。SOTA model 不需要自己阅读全量消息，cheap model 作为“阅读助手”完成粗筛和提取。

### 5.6 与其他模块的关系

```
recall()           browseHistory()
   │                    │
   │ 语义检索           │ 记录翻阅
   │ topics/facts      │ message_log + topics索引
   │ “知道什么”       │ “回忆细节”
   │                    │
   └─────┬────────┘
         │
    Agent 根据场景选择调用哪个——
    模糊记忆 → recall()
    需要细节 → browseHistory()
    也可以组合：先 recall 定位话题，再 browseHistory 读原文
```

---

## 6. 迁移策略

### 旧表 → 新表

| 旧表 | 处理 |
|------|------|
| `memories` (FTS5) | 迁移到 `core_facts` |
| `person_profiles` | 迁移到 `person_identities` + `person_group_profiles` |
| `conversation_log` | 迁移到 `topics` |
| `todos` | 保留不变 |

### 代码迁移

1. 新建 `src/memory-v2.ts`，实现 `MemoryStoreV2` class
2. 新建 `src/context-manager.ts`，实现智能 compaction 逻辑
3. 修改 `main.ts`：将 rolling truncation 替换为 `ContextManager` 调用
4. 修改 `compaction.ts`：输出目标改为 Memory V2 表
5. **直接删除** `src/memory.ts`，更新所有引用

---

## 7. 已确认的设计决策

| # | 问题 | 决策 |
|---|------|------|
| Q1 | Compaction LLM 开销 | **保持最大连续度**，仅在 token 接近上限时调用 cheap model |
| Q2 | 话题追踪精度 | **always cheap model**，reply 链 + 上下文语境分析，启发式不够 |
| Q3 | Digest 触发方式 | Agent 自己通过 **`runtime.cron` 设定定时** + 可随时**主动调用** skill |
| Q4 | 向量搜索引入时机 | **直接引入 `sqlite-vec`**，recall 以向量搜索为主，结果过多时加 cheap model 总结 |
| Q5 | 有效上下文窗口 | **推荐默认值** + config.yaml 用户可覆盖 |

---

## 附录 A：记忆系统端到端示例

以下通过 6 个真实场景，完整展示从短期到长期的记忆生命周期。

---

### A.1 一次普通的群聊回复（短期记忆 + recall）

**场景**：alice 在群里 @ agent 问"有什么好看的新番推荐吗"

```
14:00  alice: @CyberGroupmate 有什么好看的新番推荐吗

───── NC 收到事件 → drain → 进入 CodeAct session ─────

[短期记忆] messages[] 中有完整的事件文本，无需回忆

Agent session 中的代码：

  // 1. 先查中期记忆：alice 的兴趣和最近话题
  const ctx = await memorySkills.recall("alice 新番 动漫", {
    userId: "alice_123",
    chatId: "-100xxx",
    categories: ['preference', 'opinion'],
  });

  // recall 向量搜索结果：
  //   facts:
  //     [preference] "alice 喜欢治愈系和日常番"
  //     [opinion]    "alice 觉得《葬送的芙莉莲》很好看"
  //   topics:
  //     3天前的话题 "新番讨论" — alice 参与

  // 2. 基于记忆 + 当前上下文生成回复
  await ctx.tg.sendText(chatId,
    "最近有部《变人》挺治愈的，你之前喜欢芙莉莲的话应该也会喜欢！"
  );

───── Session 结束 → Compaction ─────

  // Compaction 提炼新事实：
  core_facts.insert({
    subject: "alice_123",
    content: "alice 在找新番推荐",
    category: "plan",
    expires_at: "2026-03-06"       // 一周后过期
  })
```

**记忆流转**：事件 → 短期(messages[]) → recall 拉中期记忆辅助 → 新事实写入长期

---

### A.2 活跃对话中的短期 Compaction（话题保护）

**场景**：群里连续讨论了"旅行攻略"(25条)和"编程语言"(20条)，然后有人追问旅行话题

```
14:00-14:30  [旅行攻略] alice/bob/agent 讨论东京行程  ~25条消息
14:30-14:50  [编程语言] charlie/dave 争论 Rust vs Go   ~20条消息
14:50        charlie: 对了 @CyberGroupmate
             你刚才推荐的那个东京行程规划网站叫啥

─── messages[] 已有 ~50 条,  estimateTokens() ≈ 28000 ───
─── 接近 effective_window (32000) 的 85% — 触发 Compaction ───

[Compaction 流程]

  Step 1: cheap model 分析话题线程
    话题A: "旅行攻略"  消息 #1-#25
    话题B: "编程语言"   消息 #26-#45
    当前追问提到 "东京行程" → 话题A 仍 active

  Step 2: 确定保护范围
    话题A（旅行攻略）：active → 全部 25 条消息受保护
    话题B（编程语言）：与当前追问无关 → 可压缩

  Step 3: cheap model 压缩话题B
    生成 Context Briefing:
    "[已归档] charlie 和 dave 讨论了 Rust vs Go，
     charlie 支持 Rust 的安全性，dave 支持 Go 的简洁性，
     讨论比较激烈但友好，最终没有结论"

  Step 4: 重组 messages[]
    [0]     System Prompt
    [1]     Context Briefing（话题B的摘要）
    [2..26] 话题A 的完整消息（25条，受保护！）
    [27]    charlie 的最新追问
    总 token ≈ 18000 ✓
```

**核心价值**：agent 能完整回忆推荐的网站名，不会因为中间插入无关话题就失忆。

> [!TIP]
> **消息档案检索**（详见 Section 5）：当 agent 对某个细节不确定时，可以在 CodeAct session 中主动调用 `browseHistory` 翻阅原始聊天记录：
>
> ```typescript
> // Agent 思考："charlie 问我推荐的网站，我确实推荐过但不确定名称...翻一下聊天记录"
> const result = await memorySkills.browseHistory({
>   intent: "找到我之前推荐的行程规划网站的名称",
>   hints: { chatId: "-100xxx", topicLabel: "旅行攻略", hoursBack: 4 },
> });
> // browseHistory 内部流程：
> //   1. topics 表向量搜索 → 命中 "旅行攻略" 话题 (msg#1-#25)
> //   2. 拉取 message_log msg#1~#25 的完整消息
> //   3. cheap model 阅读全部消息，提取网站名称
> //   4. 返回 result.answer = "推荐的网站是 wanderlog.com"
>
> // Agent 拿到结果后回复 charlie
> await ctx.tg.sendText(chatId,
>   `之前推荐的是 wanderlog.com ，可以建行程表还能导出 Google Maps！`
> );
> ```

---

### A.3 Reflection 触发与记忆沉淀（冷场触发）

**场景**：群聊活跃了一下午，22:00 后无人说话。2 小时冷场触发 Reflection。

```
14:00-22:00  群内多个话题（旅行/新番/代码review）
22:00        群聊静默
00:00        静默 2h → 触发 memorySkills.reflect("-100xxx")

[Reflection Skill 内部流程]

  1. 查询上次 reflect 后的数据
     topics: 5 个话题节点
     interactions: 12 条交互记录

  2. 调用 cheap model 分析，输出结构化 JSON

  3. 更新 person_group_profiles:
     alice: traits += ["热心分享旅行经验"]
            interests = ["旅行", "治愈系动漫", "摄影"]
     charlie: communication_style = "喜欢引战但不恶意"

  4. 更新 group_models:
     hot_topics = ["东京旅行", "新番推荐", "Rust vs Go"]
     avg_messages_per_day 重新计算

  5. 提炼 core_facts（跨群共享！）:
     {subject:"alice_123", content:"alice 3月初去东京旅行",
      category:"plan", expires_at:"2026-03-10"}
     {subject:"bob_456", content:"bob 推荐新宿'鮨はしもと'",
      category:"preference"}
     {subject:"charlie_789",
      content:"charlie 自称代码从不出 bug，但上月把测试数据推prod了",
      category:"anecdote"}   ← 黑历史入库！

  6. 情感记忆合并:
     alice 的 recentEpisodes (3条今天) → 保留（< 7天）
     alice 的上周 episodes (5条) → 合并为 MergedPeriod(week)
       highlights: ["一起讨论了芙莉莲最终话，她很感动"]
       overallSentiment: "positive"
       interactionCount: 5
```

---

### A.4 翻黑历史（anecdote 检索）

**场景**：charlie 在群里得意地说"我的代码从来不出 bug"

```
15:30  charlie: 我的代码从来不出 bug 😏

───── Agent 决定回复（高趣味度，适合互动）─────

Agent session 中的代码：

  // 翻 charlie 的黑历史
  const dirt = await memorySkills.recall("charlie bug 代码 事故", {
    userId: "charlie_789",
    categories: ['anecdote'],         // ← 只要趣事！
    daysBack: 365,
  });

  // recall 向量搜索命中 core_facts:
  //   [anecdote] "charlie 上月把测试数据库连接串写到 prod，
  //              导致线上用户看到了 '张三李四王五'"
  //   [anecdote] "charlie 有一次 git push --force
  //              把 bob 三天的工作覆盖了"

  // 选最好笑的回复
  await ctx.tg.sendText(chatId,
    "charlie 哥从不出 bug？上个月线上用户看到'张三李四王五'"
    + "那次是被黑客攻击了是吧 😏"
  );

15:31  charlie: 😨 你怎么什么都记得
15:31  bob: 哈哈哈哈哈 还有我那三天的代码呢
15:31  alice: 笑死

───── Feedback Loop 3min 后评估 ─────
  sentiment: positive（群友都在笑）
  → agent 强化："翻 charlie 黑历史 = 群友开心"
```

**核心价值**：`category: 'anecdote'` 确保趣事永不被合并删除，`categories` 过滤让 agent 精准翻旧账。

---

### A.5 跨群知识互通（core_facts 共享）

**场景**：agent 同时在"二次元研究所"和"旅行交流群"。alice 在两个群都在。

```
[二次元研究所]
10:00  alice: 下周要去东京 秋叶原必须去！

  → Reflection 提炼:
  core_facts.insert({
    subject: "alice_123",
    content: "alice 3月初去东京，想去秋叶原",
    category: "plan",
    expires_at: "2026-03-10"
  })
  // ← 存在 core_facts 中，不绑定 chatId → 跨群可见


[旅行交流群]（另一个群，几小时后）
15:00  alice: 有人知道东京什么酒店性价比高吗

  Agent 调用 recall:
  const ctx = await memorySkills.recall("alice 东京", {
    userId: "alice_123",
    chatId: "-200yyy",           // 旅行交流群
  });

  // 命中 core_facts（跨群共享）:
  //   "alice 3月初去东京，想去秋叶原"
  // 命中 person_group_profiles:
  //   旅行交流群的画像（如果有）

  await ctx.tg.sendText(chatId,
    "你不是要去秋叶原吗？附近有几个不错的商务酒店..."
  );

15:01  alice: 诶你怎么知道我要去秋叶原
15:01  agent: 之前在隔壁群听你提过的呀！秋叶原附近住宿的话...
       // ← 可以自然地引用跨群信息来源，模拟人类社交行为
```

**核心价值**：`core_facts` 不绑定群组 → 跨群共享。Agent 可以自然地引用跨群信息来源（如“在隔壁群听说的”），模拟人类社交中自然的信息索引词汇。`person_group_profiles` 每群独立，agent 分别对待。

---

### A.6 情感记忆渐进合并（长期记忆形成）

**场景**：展示 agent 对 bob 的记忆如何从详细逐渐模糊。

```
─── 2026年3月（当前）───

bob 的 PersonGroupProfile 在 "二次元研究所"：

recentEpisodes: [                    ← 最近7天，详细
  { date: "03-05",
    summary: "bob 推荐了《药屋少女》，我说看过了，
             他问我最喜欢哪个角色",
    sentiment: "positive", significance: 0.5 },
  { date: "03-04",
    summary: "bob 发了猫的表情包，我用狗的回复，大家笑了",
    sentiment: "positive", significance: 0.3 },
  { date: "03-02",
    summary: "bob 问 mtcute API 用法，我给了代码示例",
    sentiment: "positive", significance: 0.6 },
]

mergedMemory: [                      ← 更早的，逐级模糊
  // ── 上周（周粒度）──
  { period: "02-24 ~ 03-02",
    granularity: "week",
    overallSentiment: "positive",
    interactionCount: 8,
    highlights: ["bob 教了我一个很冷的日语冷笑话"],
    relationshipTrend: "越来越熟悉，开始开玩笑" },

  // ── 上上周（周粒度）──
  { period: "02-17 ~ 02-23",
    granularity: "week",
    overallSentiment: "neutral",
    interactionCount: 3,
    highlights: [],
    relationshipTrend: "偶尔互动" },

  // ── 2月整月（月粒度，几个周已合并）──
  { period: "2026-02",
    granularity: "month",
    overallSentiment: "positive",
    interactionCount: 22,
    highlights: [
      "bob 第一次主动跟我说话，问我是不是 bot",
      "bob 教了我一个很冷的日语冷笑话"
    ],
    relationshipTrend: "从陌生到熟悉" },

  // ── 更早会继续合并：月→季度→年 ──
]


─── Agent 使用这些记忆时的"脑内画面" ───

bob 再次找 agent 聊天时，agent 知道：

  "bob 这几天很活跃，我们聊了新番和表情包，关系不错"
      ← 来自 recentEpisodes，清晰详细

  "上周他教了我一个冷笑话，我们开始开玩笑了"
      ← 来自 week 级 mergedPeriod，有 highlight

  "2月份刚认识他的时候他还问过我是不是 bot"
      ← 来自 month 级 mergedPeriod，只剩印象深刻的事

这正是人类记忆的运作方式——
近期的事件记忆犹新，远期的只剩关键时刻。
```
