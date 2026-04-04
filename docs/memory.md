# Memory V2 — 设计文档

| 属性 | 值 |
|-----|-----|
| **状态** | `CURRENT` — 与代码实现对齐 |
| **关联任务** | Phase 6.0 — Memory V2 完全重写 |
| **作者** | arc |
| **创建日期** | 2026-02-27 |
| **最后更新** | 2026-04-04 |
| **依赖** | `better-sqlite3`, `sqlite-vec`（可选，动态加载）, `js-tiktoken`, `text-embedding-3-small`（或本地 hash fallback） |

## 目录

- [0. 设计目标](#0-设计目标)
- [1. 三层记忆模型概览](#1-三层记忆模型概览)
- [2. 短期记忆：智能上下文 Compaction](#2-短期记忆智能上下文-compaction)
  - [2.1 问题空间](#21-问题空间)
  - [2.2 分段式上下文管理](#22-设计方案分段式上下文管理)
  - [2.3 Compaction 触发策略](#23-compaction-触发策略)
  - [2.4 Compaction 执行流程](#24-compaction-执行流程)
  - [2.5 话题连贯性保护](#25-话题连贯性保护)
  - [2.6 模型能力自适应](#26-模型能力自适应)
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
- [6. Dashboard API](#6-dashboard-api)
- [7. 已确认的设计决策](#7-已确认的设计决策)
- [附录 A：端到端示例](#附录-a记忆系统端到端示例)（6 个场景）

## 变更日志

| 版本 | 日期 | 变更内容 |
|-----|------|---------| 
| v4.0 | 2026-04-04 | 全面对齐代码实现：ContextManager 集成确认；邓巴分层改为 affinityScore 驱动；Compaction §2.4-2.5 重写为 token 预算分段；Reflection 触发确认已实现；TopicNode.messageRange 改为 messageIds[]；wasEngaged 标注为未实现但已规划；新增 FTS5/sqlite-vec 双模式/LIKE fallback/Dashboard API/sticker_descriptions；删除旧 §6 迁移策略 |
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

> [!NOTE]
> ContextManager 已集成到 `MainAgentLoop.compactHistoryIfNeeded()`（主 Agent 对话历史）和 `CodeActExecutor.compactSession()` Layer 2（Subagent session），旧的 rolling truncation 已被完全替换。

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
  /** 最少保留的近期消息数（即使 token 超预算也保留） */
  minRecentMessages: number;     // 默认 6
  /** Context Briefing 的最大 token 数 */
  maxBriefingTokens: number;     // 默认 3000
}
```

**Token 计算**：使用 `js-tiktoken`（纯 JS 的 BPE tokenizer）进行精确计算。编码器在 `context-manager.ts` 中惰性初始化：

```typescript
import { encodingForModel } from 'js-tiktoken';

// 惰性初始化，失败时 fallback 到 CJK 启发式
let encoder: Tiktoken | null = null;
try {
  encoder = encodingForModel('gpt-4o');
} catch {
  // fallback: CJK 字符按 1.5 字符/token，其他按 4 字符/token
}

function estimateTokens(text: string): number {
  if (encoder) return encoder.encode(text).length;
  // CJK 启发式 fallback
  let count = 0;
  for (const ch of text) {
    count += /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/.test(ch) ? 1.5 : 0.25;
  }
  return Math.ceil(count);
}
```

> [!NOTE]
> `js-tiktoken` 是纯 JavaScript 实现，无 WASM 依赖。如果初始化失败（例如离线环境），自动 fallback 到 CJK 启发式估算。不同模型的 tokenizer 差异在 compaction 场景下可忽略（误差 < 5%），统一使用 `gpt-4o` 的 BPE 编码。

**触发条件**：`shouldCompact()` 检查 `estimateTokens(全部可见messages)` 是否超过有效窗口的 85%。有效窗口优先使用当前 LLM 模型的 `maxContextTokens`（如果配置了），否则使用 `ContextBudget.effectiveContextWindow`。

```typescript
function shouldCompact(
  messages: ChatMessage[],
  budget?: ContextBudget,
  llmConfig?: LLMConfig,  // 模型切换时自动调整
): boolean {
  const effectiveBudget = budget ?? DEFAULT_BUDGET;
  const effectiveWindow = llmConfig?.maxContextTokens
    ?? effectiveBudget.effectiveContextWindow;
  const totalTokens = estimateTokens(messages);
  return totalTokens > effectiveWindow * 0.85;
}
```

### 2.4 Compaction 执行流程

触发后调用 `compact()` 函数，使用 **token 预算分段** + **cheap model 摘要生成**：

```
Step 1: 消息分类（classifyMessages，纯算法，不调用 LLM）
├── 从消息数组尾部向前扫描
├── 按 recentHistoryRatio 预算计算 recentTokenBudget
├── 保证至少 minRecentMessages 条消息进入 recent 区域
├── 输出：
│   ├── pinnedMessages: system prompt（始终保留）
│   ├── briefingSlot: 当前的 context briefing（如果有，scope="context-briefing"）
│   ├── candidateMessages: 可被压缩的历史消息
│   └── recentMessages: 受保护的近期消息

Step 2: 识别保护范围（identifyProtectedMessages）
├── recentMessages 始终受保护
├── 外部传入的 engagedIndices（ENGAGED 话题关联消息）受保护
├── reply 链向前追溯：被保护消息的 replyToMessageId 也受保护
└── 被保护的 candidateMessages 移入 recentMessages

Step 3: 压缩未保护的消息（调用 cheap model）
├── 将未保护的 candidateMessages + 旧 briefing 合并
├── 调用 cheap model 生成新的 Context Briefing（结构化摘要）
├── Briefing token 数不超过 maxBriefingTokens
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
├── [1] Context Briefing（新生成的，scope="context-briefing"）
├── [2..] recentMessages（完整保留）
└── 总 token 应在 budget 范围内
```

### 2.5 话题连贯性保护

> [!IMPORTANT]
> 这是区别于简单"保留最后 N 条"的核心设计。保护信号来自外部，而非 compaction 内部自动检测。

**问题场景**：群里先讨论了"新番推荐"（10条消息），然后插入了一段"买外卖"的闲聊（8条消息），然后有人突然说"回到刚才的新番话题"。如果按条数截断，"新番推荐"的上下文丢了。

**解决方案**：`identifyProtectedMessages()` 接收三种外部保护信号：

```typescript
interface ProtectionSignals {
  /** 最近 N 条始终受保护（token 预算保证） */
  recentCount: number;
  /** ENGAGED 话题关联的消息索引集合（由 Recording Pipeline Triage 提供） */
  engagedIndices: Set<number>;
  /** reply 链自动向前追溯（确定性连接） */
  replyChain: Map<number, number>;  // messageIndex -> replyToIndex
}
```

**保护规则**：
1. **token 预算保护**：最近 `recentCount` 条消息由 `classifyMessages()` 保证保留
2. **ENGAGED 话题保护**：当 Recording Pipeline 的 Triage 判定某话题需要 Agent 介入时，该话题关联的所有消息索引通过 `engagedIndices` 传入，**全部受保护不被压缩**
3. **reply 链追溯**：被保护消息如果是某条消息的回复，被回复消息也自动受保护（递归追溯）

> [!NOTE]
> 与早期设计不同，当前实现**不在 compaction 热路径上调用 LLM 做话题分析**。话题信号完全由外部（Recording Pipeline Triage）提供，compaction 本身只做基于 token 预算的确定性分段 + cheap model 摘要生成。这避免了 compaction 延迟影响消息处理。

### 2.6 模型能力自适应

提供推荐默认值，允许用户在 `config.yaml` 中覆盖：

```yaml
llm:
  model: "claude-sonnet-4-20250514"
  context_budget:
    effective_window: 32000   # 用户覆盖值（可选）
    history_ratio: 0.65       # 用户覆盖值（可选）
    min_recent_messages: 6
    max_briefing_tokens: 3000
```

**Model Router 集成**：`shouldCompact()` 接受当前 LLM 模型的 `maxContextTokens` 配置。切换模型时自动调整有效窗口，可能立即触发额外 compaction。

**集成点**：
- `MainAgentLoop.compactHistoryIfNeeded()`：每次 dispatch 完成后检查主 Agent 对话历史
- `CodeActExecutor.compactSession()` Layer 2：Subagent session 中 token 超预算时调用

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
  messageRange: {                // 关联消息（完整 ID 列表，用于 browseHistory 精确拉取）
    messageIds: string[];        // 每条归属消息的 ID
    count: number;               // 消息总数
  };
  startedAt: string;             // 话题开始时间
  endedAt: string | null;        // 话题结束时间（null=仍在进行）
  sentiment: 'positive' | 'neutral' | 'negative' | 'mixed';
  relatedTopicIds: string[];     // 关联话题（话题演变链）
  keywords: string[];            // 关键词（与 Pipeline Topic.keywords 共享）
  // ─── 以下字段在 schema 中预留但尚未在应用层实现 ───
  // wasEngaged: boolean;        // [计划中] 该话题是否曾被 Agent 介入
  // interventionCount: number;  // [计划中] Agent 介入次数
  embedding?: Float32Array;      // 向量表示（用于语义检索）
  createdAt: string;
  updatedAt: string;
}
```

> [!WARNING]
> `wasEngaged` 和 `interventionCount` 字段已在 SQL schema 中创建（`was_engaged BOOLEAN DEFAULT 0`, `intervention_count INTEGER DEFAULT 0`），但当前 TypeScript 接口不包含、`rowToTopicNode()` 不读取、`upsertTopic()` 不写入。计划在未来版本中实现，以支持 Agent 自我反思"我参与过哪些话题"的能力。

#### 个体画像：双层模型

> [!IMPORTANT]
> 个体画像拆分为**全局身份**和**群内画像**两层。同一个人在不同群的行为可能完全不同（如工作群 vs 兴趣群），但某些事实（如"下周去东京"）是跨群共享的。

#### PersonIdentity（全局，跨群共享）

```typescript
interface PersonIdentity {
  userId: string;                // 主键（Telegram userId）
  displayName: string;           // 最常用的名字
  username?: string;             // 平台用户名（Telegram @username / Discord username）
  aliases: string[];             // 所有已知昵称/曾用名
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

  // ─── 邓巴分层（数据驱动，由 affinityScore 自动推导） ───
  dunbarTier: 1 | 2 | 3 | 4;    // 1=核心<=15, 2=熟悉<=50, 3=认识<=150, 4=陌生
  dunbarReason: string;          // LLM 给出的分层理由

  // ─── 亲和度评分（Reflection 计算，驱动 dunbarTier） ───
  affinityScore: number;         // 0-100，由 percentile ranking + quality delta 计算

  // ─── 群内画像（每群不同） ───
  traits: string[];              // 在这个群的性格表现
  interests: string[];           // 在这个群的兴趣话题
  communicationStyle: string;    // 在这个群的说话风格

  // ─── 关系信息（每群独立） ───
  relationToAgent: string;       // 在这个群与 agent 的关系描述

  // ─── 情感交互历史（渐进合并） ───
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

#### 邓巴分层更新逻辑：affinityScore 驱动

> [!IMPORTANT]
> v4.0 架构变更：邓巴分层不再由 LLM 直接指定，而是由 `computeAffinityScores()` 根据量化数据驱动。LLM 仅提供 `interactionQuality` 作为辅助信号。

**affinityScore 计算公式**（`reflection.ts:computeAffinityScores()`）：

```
Base Score = percentile_rank(三维度加权分)

三维度加权：
  互动次数 (50%) — 30 天内的 interaction 记录数
  活跃天数 (30%) — 30 天内有互动的不同天数
  画像深度 (20%) — traits + interests 的总数

Quality Delta（由 LLM 输出的 interactionQuality 驱动）：
  friendly   → +10
  dependent  → +15
  instrumental → ±0
  hostile    → -20

时间衰减：
  超过 14 天无互动 → 每天 -2 分

最终分数 = clamp(Base + QualityDelta - TimeDecay, 0, 100)
```

**affinityScore → dunbarTier 映射**：

| affinityScore | dunbarTier | 含义 |
|:---:|:---:|------|
| >= 90 | 1 (核心) | 高频深度互动 |
| >= 70 | 2 (熟悉) | 经常互动 |
| >= 50 | 3 (认识) | 偶尔互动 |
| < 50 | 4 (陌生) | 很少互动 |

**邓巴分层上限配置**（`config.yaml`）：

```yaml
memory:
  dunbar_limits:
    tier_1: 15    # 核心圈
    tier_2: 50    # 熟悉圈
    tier_3: 150   # 认识圈
    # tier_4 无上限
```

超过上限时，按 affinityScore 从低到高降级，确保每层人数不超限。

#### 用户画像精度与邓巴分层挂钩

> [!IMPORTANT]
> 邓巴分层直接影响画像的精度和存储长度。Tier 越高（越核心），画像越详细。

Reflection 根据用户的 `dunbarTier` 调整画像更新的粒度：

| Tier | 画像精度 | traits 上限 | interests 上限 | facts 保留 | recentEpisodes 保留 |
|------|---------|-----------|-------------|---------|------------------|
| 1 (核心) | 精细 | 10 | 15 | 全部 | 14 天 |
| 2 (熟悉) | 详细 | 6 | 10 | 全部 | 7 天 |
| 3 (认识) | 简略 | 3 | 5 | 只保留重要的 | 3 天 |
| 4 (陌生) | 最简 | 1 | 2 | 只保留核心的 | 1 天 |

#### 活跃时段更新机制

`activeHours` 由代码统计更新（`incrementProfileStats()`），不使用 LLM。同样，`messageCount` 和 `lastSeenAt` 也是程序化更新。

#### 跨群知识互通

- **事实层面**：跨群共享的事实存储在 `core_facts` 表中（`subject = userId`）。任何群的 Reflection 中发现的通用事实写入 `core_facts`，所有群可检索。
- **画像层面**：`PersonGroupProfile` 每群独立。A 群活跃不影响 B 群的 `dunbarTier`。
- **Agent 可主动关联**：`recall({ userId: "alice" })` 获取 alice 在所有群的画像和通用事实。

#### 群组画像 (GroupModel)

```typescript
interface GroupModel {
  chatId: string;                // 主键
  chatTitle: string;
  isDirectMessage?: boolean;     // 是否为私聊（由 adapter 层提供）

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
  recentFeedback: string;        // 最近收到的反馈总结（Reflection insights 写入）

  // ─── 话题偏好 ───
  hotTopics: string[];           // 近期热门话题
  tabooTopics: string[];         // 不宜讨论的话题

  // ─── 反思状态 ───
  lastReflectedAt: string | null; // 上次反思时间
  updatedAt: string;
}
```

> [!NOTE]
> `isDirectMessage` 区分私聊和群聊。私聊有专用的 Reflection prompt（`reflection-dm-user-instruction.md`）和亲和度加成。

### 3.2 情感记忆渐进合并

近期交互 (`recentEpisodes`) 随时间推移自动合并为更粗粒度的 `mergedMemory`：

```
7 天内: 保留每条 InteractionEpisode（完整细节）
        ↓ mergeEpisodes() + LLM 辅助分析
7-30 天: 合并为 week 粒度的 MergedMemory
        ↓ cascadeMerge() + LLM 辅助分析
30-90 天: 合并为 month 粒度
        ↓ cascadeMerge()
90-365 天: 合并为 quarter 粒度
        ↓ cascadeMerge()
>1 年: 合并为 year 粒度
```

每层合并时：
1. 过滤出低重要性事件（`significance < 0.7`）
2. 保留高重要性事件的摘要写入 `highlights`
3. 聚合 `interactionCount`
4. 更新整体 `overallSentiment` 和 `relationshipTrend`

**LLM 辅助两层合并**（`reflection.ts`）：

| 合并类型 | 函数 | Prompt 模板 | 说明 |
|---------|------|------------|------|
| episode -> week | `mergeEpisodes()` | `merge-episodes-user.md` | 将 7+ 天的 episodes 合并为 week 级 MergedMemory |
| week -> month -> quarter -> year | `cascadeMerge()` | `merge-cascade-user.md` | 级联合并更早的 MergedMemory |

两个函数都有 **LLM 失败 fallback**：如果 LLM 调用失败，自动退化为规则合并（取最高频 sentiment、拼接 highlights、求和 interactionCount）。

```typescript
interface MergedMemory {
  periodStart: string;
  periodEnd: string;
  granularity: 'week' | 'month' | 'quarter' | 'year';
  overallSentiment: 'positive' | 'neutral' | 'negative' | 'mixed';
  interactionCount: number;
  highlights: string[];          // 只保留重要事件（significance > 0.7）的摘要
  relationshipTrend: string;     // LLM 总结的关系趋势
}
```

### 3.3 中期记忆更新机制：Reflection Skill

> [!IMPORTANT]
> Reflection 已在 `main.ts` 中完整集成自动触发，支持三种触发模式。

#### 触发方式

| 触发类型 | 机制 | 条件 |
|---------|------|------|
| **冷场触发** | `main.ts` 定时器检测群组静默时长 | `silentSec >= silenceThreshold`（默认 7200s = 2h） |
| **最大间隔触发** | 定时器检测距上次反思的时间 | `sinceReflectionSec >= maxInterval`（默认 86400s = 24h） |
| **作息触发** | 非活跃时段自动触发 | `isOutsideAwakeHours() && sinceReflectionSec > 3600` |
| **手动触发** | CLI 命令 `reflect <chatId>` | 即时执行 |
| **API 触发** | Dashboard API `POST /api/reflect` | 即时执行 |
| **Sandbox 触发** | Agent CodeAct `memory.reflect(chatId)` | 即时执行 |

**实现细节**（`main.ts:640-735`）：
- `lastActivityPerChat` Map 跟踪每群最后活动时间
- `setInterval(checkInterval)` 定时器扫描（默认 5 分钟）
- 参数支持 `config.yaml` 热重载（每次检查时 `loadConfig()` 重新读取）
- `reflectionInProgress` Set 防止同群并发反思

```yaml
reflection:
  check_interval: 300          # 检查间隔（秒），默认 5 分钟
  silence_threshold: 7200      # 冷场触发阈值（秒），默认 2 小时
  max_interval: 86400          # 最大间隔（秒），默认 24 小时
  awake_hours: [9, 23]         # 活跃时段，默认 9:00-23:00
```

#### Reflection 执行流程（6+ 步）

```
Step 1: 数据收集
├── getTopicsSince(chatId, lastReflectedAt)  → 上次反思后的话题
├── getInteractionsSince(chatId, ...)        → 上次反思后的交互
├── getProfilesForChat(chatId)               → 当前所有群内画像
├── listCoreFacts({ subject: chatId })       → 已有事实（供 LLM 对比去重/更新/删除）
└── getGroupModel(chatId)                    → 群组画像

Step 2: 量化统计（computeParticipantStats）
├── countRecentMessages(chatId, 7)           → 计算 avgMessagesPerDay
├── countInteractionsPerUser(chatId, 30)     → 30天互动数据（亲和度用）
└── 合并每个参与者的：消息数、有互动的天数、主题分布

Step 3: LLM 调用（cheap model）
├── 构建 prompt（包含话题摘要、交互记录、现有画像、已有事实列表）
├── 使用 reflection-user-instruction.md / reflection-dm-user-instruction.md
└── 返回结构化 JSON（personUpdates[], factUpdates[], groupInsights）

Step 4: 解析 + 写入（多个子步骤）
├── 4a': 更新 person_identities（displayName, aliases）
├── 4a:  写入画像增量（traits, interests, communicationStyle, relationToAgent）
├── 4a-score: computeAffinityScores() → 计算 affinityScore → 推导 dunbarTier
├── 4a'': 写入 recentEpisodes（LLM 生成的新交互记录）
├── 4b:  事实更新（Create / Update / Delete）
│   ├── action: "upsert" → storeFact() 或 updateFact()
│   ├── action: "delete" → deleteFact()
│   └── 新事实自动生成 embedding（getEmbeddingConfig()）
├── 4b': 回写话题情感（sentiment）到 topics 表
├── 4c:  更新群组画像 + avgMessagesPerDay + insights → recentFeedback
├── 4d:  情感记忆合并（mergeEpisodes + cascadeMerge，LLM 辅助）
├── 4e:  邓巴分层精度裁剪（trimProfileByTier）
└── 4f:  邓巴分层人数上限检查（超限降级）

Step 5: 返回 ReflectionResult
├── reflectedPeriod: { from, to }
├── personUpdates[]: { userId, chatId, changes }
├── newCoreFacts[]: 新增事实列表
├── mergedEpisodes: 合并的 episode 数量
└── insights: 群组洞察

Step 6: 追加反思记录到 agent-state.md
```

**内部依赖方法**（`MemoryStoreV2` 实现类中存在但 `IMemoryStoreV2` 接口未声明的方法，Reflection 核心逻辑依赖）：

| 方法 | 用途 |
|------|------|
| `countRecentMessages(chatId, days)` | Step 2: 计算 avgMessagesPerDay |
| `countInteractionsPerUser(chatId, days)` | Step 4a-score: 30 天互动数据，亲和度计算 |
| `getEmbeddingConfig()` | Step 4b: 获取 embedding 配置为新 fact 生成向量 |
| `listCoreFacts(options)` | Step 1: 获取已有事实供 LLM 对比 |
| `updateFact(id, data)` | Step 4b: 更新已有事实 |
| `deleteFact(id)` | Step 4b: 删除已过时事实 |

### 3.4 SQLite 表结构

```sql
-- 话题节点
CREATE TABLE IF NOT EXISTS topics (
    id TEXT PRIMARY KEY,
    pipeline_topic_id TEXT,
    chat_id TEXT NOT NULL,
    label TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    key_points TEXT NOT NULL DEFAULT '[]',        -- JSON array
    participants TEXT NOT NULL DEFAULT '[]',       -- JSON array
    keywords TEXT NOT NULL DEFAULT '[]',           -- JSON array
    message_ids TEXT NOT NULL DEFAULT '[]',        -- JSON array of message IDs
    message_count INTEGER DEFAULT 0,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    sentiment TEXT DEFAULT 'neutral',
    related_topic_ids TEXT DEFAULT '[]',           -- JSON array
    was_engaged BOOLEAN DEFAULT 0,                 -- [尚未实现] Agent 是否介入过
    intervention_count INTEGER DEFAULT 0,          -- [尚未实现] Agent 介入次数
    embedding BLOB,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topics_chat_date ON topics(chat_id, started_at);
CREATE INDEX IF NOT EXISTS idx_topics_pipeline_id ON topics(pipeline_topic_id);

-- 个体身份（全局）
CREATE TABLE IF NOT EXISTS person_identities (
    user_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL DEFAULT '',
    username TEXT,
    aliases TEXT NOT NULL DEFAULT '[]',
    total_message_count INTEGER DEFAULT 0,
    last_seen_at TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- 个体群内画像
CREATE TABLE IF NOT EXISTS person_group_profiles (
    user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    dunbar_tier INTEGER DEFAULT 4,
    dunbar_reason TEXT DEFAULT '',
    affinity_score REAL DEFAULT 0,
    traits TEXT DEFAULT '[]',
    interests TEXT DEFAULT '[]',
    communication_style TEXT DEFAULT '',
    relation_to_agent TEXT DEFAULT '',
    recent_episodes TEXT DEFAULT '[]',
    merged_memory TEXT DEFAULT '[]',
    message_count INTEGER DEFAULT 0,
    last_seen_at TEXT NOT NULL,
    active_hours TEXT DEFAULT '[]',
    first_seen_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_profiles_chat ON person_group_profiles(chat_id);

-- 群组画像
CREATE TABLE IF NOT EXISTS group_models (
    chat_id TEXT PRIMARY KEY,
    chat_title TEXT DEFAULT '',
    is_direct_message INTEGER DEFAULT 0,
    description TEXT DEFAULT '',
    dominant_language TEXT DEFAULT '',
    communication_norms TEXT DEFAULT '[]',
    active_members INTEGER DEFAULT 0,
    avg_messages_per_day REAL DEFAULT 0,
    peak_hours TEXT DEFAULT '[]',
    agent_role TEXT DEFAULT '',
    engagement_level TEXT DEFAULT 'low',
    recent_feedback TEXT DEFAULT '',
    hot_topics TEXT DEFAULT '[]',
    taboo_topics TEXT DEFAULT '[]',
    last_reflected_at TEXT,
    updated_at TEXT NOT NULL
);

-- 核心事实（长期记忆）
CREATE TABLE IF NOT EXISTS core_facts (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    confidence REAL DEFAULT 1.0,
    source TEXT,
    embedding BLOB,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_facts_subject ON core_facts(subject);

-- 交互记录
CREATE TABLE IF NOT EXISTS interactions (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    topic_id TEXT,
    type TEXT NOT NULL,
    summary TEXT NOT NULL,
    sentiment TEXT DEFAULT 'neutral',
    significance REAL DEFAULT 0.5
);
CREATE INDEX IF NOT EXISTS idx_interactions_chat_date ON interactions(chat_id, date);

-- 消息日志
CREATE TABLE IF NOT EXISTS message_log (
    message_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    text TEXT NOT NULL,
    reply_to_message_id TEXT,
    timestamp TEXT NOT NULL,
    media_type TEXT,
    media_info TEXT,
    PRIMARY KEY (message_id, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON message_log(chat_id, timestamp);

-- FTS5 全文搜索虚拟表（手动同步，recall() 和 browseHistory() 使用）
CREATE VIRTUAL TABLE IF NOT EXISTS topics_fts USING fts5(
    label, summary, keywords,
    content='topics', content_rowid='rowid'
);
CREATE VIRTUAL TABLE IF NOT EXISTS core_facts_fts USING fts5(
    content, subject,
    content='core_facts', content_rowid='rowid'
);

-- sqlite-vec 向量索引（动态加载，可选）
-- 如果 sqlite-vec 扩展加载成功，自动创建：
--   CREATE VIRTUAL TABLE IF NOT EXISTS vec_topics USING vec0(embedding float[{dim}]);
--   CREATE VIRTUAL TABLE IF NOT EXISTS vec_facts USING vec0(embedding float[{dim}]);
-- 维度取决于 embedding 模型（text-embedding-3-small = 1536）
-- 如果已有表维度不匹配，自动 DROP + 重建

-- 贴纸描述缓存
CREATE TABLE IF NOT EXISTS sticker_descriptions (
    unique_file_id TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    emoji TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

> [!NOTE]
> **FTS5 同步**：topics_fts 和 core_facts_fts 在每次 upsert/store 操作后手动同步（INSERT OR REPLACE）。不使用 triggers 以保持写入性能可控。
>
> **sqlite-vec 加载**：通过 `createRequire()` + ESM 桥接动态加载 native 扩展。加载失败时透明 fallback 到纯 JS 余弦相似度（`vectorSearchTopics()` / `vectorSearchFacts()`），功能完全一致但性能较低。

### 3.5 Compaction 与 Recording Pipeline 的职责划分

| 维度 | Compaction (§2) | Recording Pipeline |
|------|----------------|-------------------|
| **触发时机** | LLM 调用前（token 超预算时） | 消息缓冲满 / 静默超时 |
| **处理对象** | `messages[]` 数组 | 原始消息 buffer |
| **处理方式** | 压缩为 Context Briefing | 聚类话题 + 摘要 + 持久化 |
| **LLM 使用** | cheap model 摘要（热路径最小化） | cluster + triage LLM |
| **输出** | 更新后的 `messages[]` | SQLite: topics, message_log |
| **message_log 写入** | 不写入 | Step 4 批量写入 |

### 3.6 话题生命周期：从实时到持久

```
新消息到达
    ↓
TopicRegistry.assignMessages()
├── 相似度匹配 → 复用现有 Topic（ACTIVE 状态）
└── 无匹配 → 创建新 Topic（ACTIVE 状态）
    ↓
RecordingPipeline.flush()
├── Step 1: LLM 聚类（cluster-user.md）
├── Step 2: 摘要 + 关键词 → updateRegistry()
├── Step 3: Triage → ENGAGED 状态 / 静默
└── Step 4: upsertTopic() → 写入/更新 SQLite topics 表
    ↓
时间推移
├── ACTIVE → STALE（15 分钟无新消息）
├── STALE → ARCHIVED（2 小时无新消息）
├── ARCHIVED → finalizeTopic()（设置 ended_at）
└── ARCHIVED 超 24 小时 → 从 Registry 清除
    ↓
Reflection（定期触发）
├── getTopicsSince() 读取持久化话题
├── 更新话题情感（sentiment）
└── 基于话题提炼事实和画像
```

---

## 4. 统一检索入口 recall()

### 4.1 Embedding 策略

**模型选择**：`text-embedding-3-small`（OpenAI），1536 维。

**双模式搜索架构**：

| 模式 | 条件 | 性能 |
|------|------|------|
| **sqlite-vec 加速** | `sqlite-vec` 扩展成功加载 | 毫秒级向量搜索，SQL 原生集成 |
| **纯 JS fallback** | 扩展加载失败 | 全表扫描 + JS 余弦相似度，功能完整但慢 |

sqlite-vec 通过 `createRequire()` + ESM 桥接动态加载。`initVecTables()` 在启动时检查已有虚拟表的维度是否与当前模型匹配，不匹配时自动 DROP + 重建。

**Embedding 生成**：
- API 模式：调用 OpenAI embedding API
- Hash fallback：离线环境下使用本地 hash 生成伪向量（语义质量降低但功能可用）

### 4.2 事实分类 FactCategory

```typescript
type FactCategory =
  | 'biographical'    // 个人信息（"alice 是前端程序员"）
  | 'preference'      // 喜好（"bob 喜欢抹茶拿铁"）
  | 'anecdote'        // 趣事/黑历史（永不过期、永不在合并中删除）
  | 'opinion'         // 观点（"alice 觉得 Rust 比 Go 好"）
  | 'plan'            // 计划（"alice 下周去东京"，带 expires_at）
  | 'relationship'    // 人际关系（"alice 和 bob 是同事"）
  | 'general';        // 通用事实
```

### 4.3 RecallOptions 与 RecallResult

```typescript
interface RecallOptions {
  chatId?: string;           // 限定群组
  userId?: string;           // 限定用户
  daysBack?: number;         // 时间范围（天）
  maxResults?: number;       // 最大结果数
  categories?: FactCategory[];  // 按事实类别过滤
  deepRecallThreshold?: number; // 默认 2000 tokens
}

interface RecallResult {
  topics: TopicNode[];       // 匹配的话题节点
  facts: Array<{
    content: string;
    category: FactCategory;
    subject: string;
    confidence: number;
  }>;
  persons: PersonGroupProfile[];  // 匹配的个体画像
  deepSummary?: string;      // 如果触发了深度总结
}
```

### 4.4 recall() 实现流程

```
输入: query="alice 之前说她要去哪里旅行？"

Step 1: 生成 query embedding
├── 调用 embedding API (text-embedding-3-small)
└── 或 hash fallback

Step 2: 三层搜索（并行执行）
├── Layer 1: 向量搜索（主路径）
│   ├── sqlite-vec 模式: SQL 向量距离查询
│   └── JS fallback 模式: 全表余弦相似度
├── Layer 2: FTS5 全文搜索（补充）
│   ├── topics_fts: MATCH query
│   └── core_facts_fts: MATCH query
└── Layer 3: LIKE fallback（兜底）
    └── 当 FTS5 无结果时，使用 SQL LIKE '%keyword%' 搜索

Step 3: 合并去重
├── topics: 按 similarity 排序，去重
├── facts: 按 relevance 排序，去重
└── persons: 如果 userId 匹配，附加画像

Step 4: Token 估算 + Deep Recall
├── 使用 estimateTokens() 精确计算结果 token 数
│   (TODO: 当前使用 text.length/2 启发式，
│    应改为调用 context-manager.ts 的 tiktoken 实现)
├── 如果总 token > deepRecallThreshold (默认 2000):
│   ├── 调用 cheap model 对结果做综合摘要
│   └── 写入 deepSummary
└── 返回 RecallResult
```

> [!NOTE]
> **三层 fallback 策略**确保在各种数据质量下都能返回结果：
> - 向量搜索依赖 embedding 质量，对语义模糊查询最好
> - FTS5 依赖关键词匹配，对精确短语查询最好
> - LIKE 作为最后兜底，对简单子串匹配有效

---

## 5. 消息档案模块 Message Archive

### 5.1 为什么需要消息档案

Agent 需要"原文回忆"能力——当用户问"alice 昨天具体怎么说的？"时，仅靠话题摘要不够。Agent 需要能精确定位到相关消息段落，给出带原文引用的回答。

### 5.2 消息存储

`message_log` 表在两个时机写入：
1. **即时落盘**：`main.ts nc.onPush()` 中每条消息到达时立即 `storeMessageBatch()`（确保 attend-handler 能即时查到最新消息）
2. **Pipeline 批量写入**：`RecordingPipeline.flush()` Step 4 批量写入（`INSERT OR IGNORE` 避免与即时落盘冲突）

### 5.3 HistoryBrowseRequest / HistoryBrowseResult

```typescript
interface HistoryBrowseRequest {
  intent: string;              // 自然语言搜索意图
  hints?: {
    chatId?: string;
    userId?: string;
    topicLabel?: string;
    topicId?: string;
    hoursBack?: number;
    daysBack?: number;
  };
  contextWindow?: number;      // 命中消息前后各多少条，默认 10
  maxSegments?: number;        // 最大结果数，默认 3
}

interface HistoryBrowseResult {
  answer: string;              // cheap model 生成的针对性回答
  segments: Array<{
    topicLabel: string;
    timeRange: { from: string; to: string };
    messages: Array<{
      messageId: string;
      userId: string;
      displayName: string;
      text: string;
      timestamp: string;
    }>;
    relevanceScore: number;
  }>;
  messagesRead: number;        // 总共阅读了多少条消息
}
```

### 5.4 检索流程

```
输入: intent="alice 上次怎么评价那家日料店的？"

Step 1: 意图解析（LLM 辅助）
├── cheap model 解析: 关键人物=alice, 关键话题=日料店, 时间=recent
└── 生成结构化搜索参数

Step 2: 定位相关话题
├── recall(query) 搜索相关 TopicNode
└── 按 relevance + 时间排序

Step 3: 精确拉取消息段落
├── 使用 topic.messageRange.messageIds 精确查询
│   → SELECT * FROM message_log WHERE message_id IN (...)
├── 添加上下文窗口（前后 contextWindow 条消息）
└── 返回完整消息段落

Step 4: LLM 深度阅读
├── cheap model 阅读消息段落
├── 生成针对性回答（带原文引用）
└── 返回 HistoryBrowseResult
```

### 5.5 模糊搜索的关键设计

用户的搜索意图通常是模糊的（"之前聊的那个什么"），因此检索链从模糊到精确逐步收敛：

```
模糊意图 → LLM 意图解析 → recall() 定位话题
→ messageIds 精确拉取 → contextWindow 扩展
→ LLM 深度阅读 → 结构化回答
```

### 5.6 与其他模块的关系

```
                    写入方向
                    ────────→
┌─────────┐    ┌──────────────┐    ┌─────────────┐
│ NC消息流 │───→│ message_log  │←───│ Recording   │
│(即时落盘)│    │              │    │ Pipeline    │
└─────────┘    └──────────────┘    └─────────────┘
                    ↑                     │
                    │                     ↓
              ┌─────────────┐    ┌─────────────┐
              │browseHistory│    │   topics     │
              │  (读取)     │    │ (写入+更新) │
              └─────────────┘    └─────────────┘
                    ↑
                    │ recall() 定位
              ┌─────────────┐
              │  Agent 查询  │
              └─────────────┘
```

---

## 6. Dashboard API

> [!NOTE]
> `MemoryStoreV2` 实现类包含 20 个公开方法未在 `IMemoryStoreV2` 接口中声明。这些方法主要服务于 Dashboard 运维界面和内部模块（Reflection、Sticker），不属于 Agent 核心检索路径。

### Dashboard CRUD 方法分类

| 类别 | 方法 | 说明 |
|------|------|------|
| **身份管理** | `listPersonIdentities(limit, offset)` | 分页列出全局身份 |
| | `deletePersonIdentity(userId)` | 删除全局身份 |
| | `deletePersonGroupProfile(userId, chatId)` | 删除群内画像 |
| **群组管理** | `listGroupModels()` | 列出全部群组画像 |
| **事实管理** | `listCoreFacts(options)` | 分页/过滤/搜索事实 |
| | `updateFact(id, data)` | 更新事实内容/分类/置信度 |
| | `deleteFact(id)` | 删除事实 |
| **交互管理** | `listInteractions(options)` | 分页列出交互记录 |
| | `deleteInteraction(id)` | 删除交互记录 |
| **消息管理** | `listMessages(options)` | 分页/搜索消息日志 |
| | `deleteMessages(chatId, messageIds)` | 批量删除消息 |
| | `updateMessage(chatId, messageId, data)` | 更新消息文本/显示名 |
| **贴纸缓存** | `getStickerDescription(uniqueFileId)` | 获取贴纸描述 |
| | `setStickerDescription(uniqueFileId, desc, emoji)` | 设置贴纸描述 |
| | `getAllStickerDescriptions()` | 列出全部贴纸描述 |
| | `deleteStickerDescription(uniqueFileId)` | 删除贴纸描述 |
| | `updateStickerDescription(uniqueFileId, desc, emoji)` | 更新贴纸描述 |
| | `searchStickersByEmoji(emojis, limit)` | 按 emoji 搜索贴纸 |
| **内部统计** | `countRecentMessages(chatId, days)` | Reflection 依赖 |
| | `countInteractionsPerUser(chatId, days)` | Reflection 依赖 |

> [!WARNING]
> 这些方法未在 `IMemoryStoreV2` 接口中声明。如果将接口用于依赖注入或 mock 测试，需要注意 Reflection 内部依赖了 `countRecentMessages`、`countInteractionsPerUser`、`getEmbeddingConfig` 三个未声明方法。建议未来将接口拆分为 `ICoreMemory` + `IDashboardMemory` + `IInternalMemory`。

---

## 7. 已确认的设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| **DB** | SQLite (better-sqlite3) | 同步 API、零运维、单文件备份 |
| **向量搜索** | sqlite-vec + JS fallback 双模式 | 有原生扩展用原生，没有也能工作 |
| **全文搜索** | FTS5 虚拟表 | SQLite 原生支持，无额外依赖 |
| **Token 计算** | js-tiktoken + CJK fallback | 纯 JS、无 WASM、惰性初始化 |
| **Embedding** | text-embedding-3-small + hash fallback | API 不可用时功能降级但不崩溃 |
| **邓巴分层** | affinityScore 数据驱动 + LLM 辅助 | 可量化、可复现、不依赖 LLM 判断稳定性 |
| **Compaction** | token 预算分段 + cheap model 摘要 | 避免热路径 LLM 调用，保持低延迟 |
| **fact 操作** | Create / Update / Delete 完整生命周期 | 事实会过时和变化，需要能更新和删除 |
| **消息落盘** | 即时落盘 + Pipeline 批量写入 | 即时可查 + 批量高效 |
| **Reflection 触发** | 冷场 + 最大间隔 + 作息，三模式 | 覆盖各种群组活跃度模式 |
| **SQL 安全** | SafeUpdateBuilder + SafeSelectBuilder | 消除 SQL 注入风险，编译期类型检查 |

---

## 附录 A：记忆系统端到端示例

### A.1 新成员首次发言

```
用户 charlie 首次在群中发言: "大家好！我是新来的，做 iOS 开发的"

1. NC.onPush → message_log 即时落盘
2. TopicRegistry.assignMessages() → 创建新 Topic "自我介绍"
3. RecordingPipeline.flush()
   → Step 1: LLM 聚类确认 "自我介绍" 话题
   → Step 2: 摘要 "charlie 自我介绍，iOS 开发者"
   → Step 4: upsertTopic() + storeMessageBatch()
4. Reflection（2h 后冷场触发）
   → upsertPersonIdentity(charlie, {displayName: "charlie"})
   → upsertPersonGroupProfile(charlie, chatId, {dunbarTier: 4, traits: ["友好"], interests: ["iOS"]})
   → storeFact(charlie, "charlie 是 iOS 开发者", "biographical")
```

### A.2 Agent 主动回忆

```
用户 alice: "之前 bob 推荐的那家日料店叫什么来着？"

1. Agent 调用 memory.recall("bob 推荐的日料店")
2. recall() 执行:
   → 向量搜索 topics → 找到 TopicNode "美食推荐"（相似度 0.87）
   → FTS5 搜索 core_facts → 找到 "bob 推荐了银座一家日料店叫�的"
   → 合并结果，token 估算 < 2000，不触发 deep summary
3. Agent 回复: "bob 之前推荐的是银座那家「鮨の」，说刺身很新鲜"
```

### A.3 跨群知识互通

```
群 A 的 Reflection 发现: "alice 下周要去东京旅行"
→ storeFact(alice, "alice 下周去东京旅行", "plan", expiresAt="2026-04-15")

群 B 里有人问: "alice 最近有什么计划？"
→ Agent 调用 recall("alice 计划", {userId: alice})
→ 找到跨群事实 "alice 下周去东京旅行"
→ Agent: "alice 好像下周要去东京旅行"
```

### A.4 邓巴分层变化

```
alice 在过去 30 天内:
  互动次数: 45 次（top 5%）
  活跃天数: 20 天
  画像深度: traits=5, interests=8 → total=13
  interactionQuality: "friendly"
  最后互动: 2 天前

computeAffinityScores():
  Base = percentile_rank(45*0.5 + 20*0.3 + 13*0.2) = 92
  Quality Delta = +10 (friendly)
  Time Decay = 0 (2天 < 14天阈值)
  Final = min(92 + 10, 100) = 100

  → affinityScore = 100 → dunbarTier = 1 (核心)
```

### A.5 Compaction 触发

```
MainAgentLoop.compactHistoryIfNeeded():
  conversationHistory.length = 25 条消息
  estimateTokens(全部) = 28,500 tokens
  effectiveWindow = 32,000 (from llmConfig.maxContextTokens)
  28,500 > 32,000 * 0.85 = 27,200 → 触发 compact

compact() 执行:
  classifyMessages():
    → recentMessages: 最后 8 条 (约 9,000 tokens)
    → candidateMessages: 前 17 条
    → pinnedMessages: system prompt
  identifyProtectedMessages():
    → engagedIndices 保护了 3 条与活跃话题相关的消息
    → 3 条从 candidates 移入 recent
  LLM 摘要:
    → 14 条未保护消息压缩为 Context Briefing (~2,800 tokens)
  重组后:
    → system + briefing + 11 条 recent = ~16,000 tokens ✓
```

### A.6 深度历史检索

```
用户: "帮我查一下上周三 bob 说的那段话，就是关于 Rust 和 Go 对比的"

Agent 调用 memory.browseHistory({
  intent: "bob 上周三说的关于 Rust 和 Go 对比的话",
  hints: { daysBack: 10 }
})

browseHistory() 执行:
  Step 1: LLM 意图解析
    → 关键人物: bob, 话题: Rust vs Go, 时间: ~7 天前
  Step 2: recall() 搜索
    → 找到 TopicNode: "编程语言讨论" (started_at: 上周三)
    → messageRange.messageIds: ["msg_201", "msg_202", ..., "msg_218"]
  Step 3: 精确拉取
    → SELECT * FROM message_log WHERE message_id IN ("msg_201",...,"msg_218")
    → 补充 contextWindow=10 条上下文
  Step 4: LLM 深度阅读
    → 生成回答: "bob 在上周三说：'Rust 的所有权模型虽然学习曲线陡，
       但在并发场景下比 Go 的 goroutine 更安全...'（msg_209）"
    → messagesRead: 28
```
