
# 群聊 Agent 记忆召回系统

---

## A. Recording Pipeline：Topic 关联记忆预计算

在 RecordingPipeline flush → LLM 聚类完成后，紧接着做一轮程序化 FTS 检索，将结果持久化到 topic 记录上。

### Topics 表新增字段

```sql
ALTER TABLE topics ADD COLUMN associated_memories TEXT DEFAULT NULL;  -- JSON array
ALTER TABLE topics ADD COLUMN callback_potential INTEGER DEFAULT 0;   -- 0-100
```

### 实现逻辑（recording-pipeline.ts flush 后追加）

```typescript
async function computeTopicAssociations(topic: Topic, chatId: string): Promise<void> {
  const keywords = topic.keywords; // e.g. ["表情包", "偷", "先发"]
  const participants = topic.participants;

  // 1. FTS 搜索 core_facts
  const ftsQuery = keywords.map(k => `"${k}"`).join(' OR ');
  const relatedFacts: CoreFact[] = db.prepare(`
    SELECT cf.* FROM core_facts cf
    JOIN core_facts_fts fts ON cf.rowid = fts.rowid
    WHERE core_facts_fts MATCH ?
    ORDER BY rank
    LIMIT 15
  `).all(ftsQuery);

  // 2. FTS 搜索历史 topics（排除自身）
  const relatedTopics: Topic[] = db.prepare(`
    SELECT t.topic_id, t.title, t.summary, t.keywords, t.participants, t.start_time, t.end_time
    FROM topics t
    JOIN topics_fts fts ON t.rowid = fts.rowid
    WHERE topics_fts MATCH ?
      AND t.topic_id != ?
      AND t.status = 'ARCHIVED'
    ORDER BY rank
    LIMIT 10
  `).all(ftsQuery, topic.topicId);

  // 3. 计算 callback_potential（纯程序化评分）
  let score = 0;
  // 每个匹配的 anecdote 类事实 +15
  const anecdoteMatches = relatedFacts.filter(f => f.category === 'anecdote');
  score += anecdoteMatches.length * 15;
  // 每个其他类别事实 +5
  score += (relatedFacts.length - anecdoteMatches.length) * 5;
  // 历史话题参与者与当前话题参与者重叠 → 每个重叠 +10
  for (const rt of relatedTopics) {
    const rtParticipants = JSON.parse(rt.participants || '[]');
    const overlap = rtParticipants.filter((p: string) => participants.includes(p));
    score += overlap.length * 10;
  }
  // 匹配历史话题本身 +5 per topic
  score += relatedTopics.length * 5;
  score = Math.min(score, 100);

  // 4. 组装并写入
  const associatedMemories = [
    ...relatedFacts.slice(0, 5).map(f => ({
      type: 'core_fact' as const,
      subject: f.subject,
      category: f.category,
      content: f.content,
      confidence: f.confidence,
    })),
    ...relatedTopics.slice(0, 3).map(t => ({
      type: 'topic' as const,
      topicId: t.topic_id,
      title: t.title,
      summary: t.summary,
      timeRange: `${t.start_time} ~ ${t.end_time}`,
    })),
  ];

  db.prepare(`
    UPDATE topics 
    SET associated_memories = ?, callback_potential = ?
    WHERE topic_id = ?
  `).run(JSON.stringify(associatedMemories), score, topic.topicId);
}
```

全程序化，0 延迟。聚类后立即执行，结果持久化在 topic 上，后续所有环节直接读取。

---

## B. Triage: callbackPotential 提权

在 RecordingPipeline triage 决定入队 Q3 时，检查 `callback_potential` ：

```typescript
// recording-pipeline.ts, triage 阶段
function computeTriagePriority(topic: Topic, baseEngagement: number): number {
  let priority = baseEngagement;
  
  // callback_potential > 60 时追加提权
  if (topic.callback_potential > 60) {
    const boost = Math.floor((topic.callback_potential - 60) * 0.5); // 60→0, 80→10, 100→20
    priority += boost;
  }
  
  return priority;
}

// 入队时
q3.enqueue(chatId, {
  priority: computeTriagePriority(topic, baseEngagement),
  metadata: {
    topicId: topic.topicId,
    hasHighCallbackPotential: topic.callback_potential > 70,
  }
});
```

效果：当一个新话题和过去的"有趣事件"高度关联时，Agent 更倾向主动参与，而非沉默。

---

## C. ContextBuilder 增强：Main Agent 看到什么

### GroupContextPackage 新增字段

```typescript
interface GroupContextPackage {
  // === 现有字段 ===
  messages: FormattedMessage[];
  topicDigests: TopicDigest[];
  groupModel: GroupModel;
  
  // === 新增字段 ===
  activeUserProfiles: ActiveUserProfile[];  // 当前消息缓冲中出现过的用户的群内画像
}

interface ActiveUserProfile {
  userId: string;
  displayName: string;
  aliases: string[];
  dunbarTier: string;      // T1-T4
  rapport: number;         // 好感度
  traits: string;          // 人物特征
  communicationStyle: string;
  relationWithAgent: string;
  messageCount: number;
}

interface TopicDigest {
  // === 现有字段 ===
  topicId: string;
  title: string;
  summary: string;
  keywords: string[];
  participants: string[];
  sentiment: string;
  status: string;
  
  // === 新增字段 ===
  associatedMemories?: AssociatedMemory[];  // 来自 Section A 的预计算
  callbackPotential?: number;
}
```

### ContextBuilder 实现变更

```typescript
// context-builder.ts

function buildGroupContext(chatId: string, depth: ContextDepth): GroupContextPackage {
  // ... 现有逻辑: messages, topicDigests, groupModel ...

  // 新增: 获取活跃用户画像
  const activeUserIds = extractUniqueUserIds(messages); // 从消息中提取所有发言者userId
  const activeUserProfiles = activeUserIds
    .map(uid => memoryV2.getPersonGroupProfile(uid, chatId))
    .filter(Boolean)
    .map(profile => ({
      userId: profile.userId,
      displayName: profile.displayName,
      aliases: profile.aliases || [],
      dunbarTier: profile.dunbarTier,
      rapport: profile.rapport,
      traits: profile.traits,
      communicationStyle: profile.communicationStyle,
      relationWithAgent: profile.relationWithAgent,
      messageCount: profile.messageCount,
    }));

  // 新增: topicDigests 附带 associatedMemories
  const enrichedTopicDigests = topicDigests.map(td => {
    const topicRecord = memoryV2.getTopic(td.topicId);
    return {
      ...td,
      associatedMemories: topicRecord?.associated_memories 
        ? JSON.parse(topicRecord.associated_memories) 
        : undefined,
      callbackPotential: topicRecord?.callback_potential || 0,
    };
  });

  return {
    messages,
    topicDigests: enrichedTopicDigests,
    groupModel,
    activeUserProfiles,
  };
}
```

### 按 CosineDecay 深度控制注入量

| 深度 | 消息数 | 用户画像 | Topic 附带 associatedMemories |
|:-----|:------|:---------|:----------------------------|
| L0 | 10 | 仅最近 2 条消息的发言者 | 不附带 |
| L1 | 30 | 所有活跃发言者 | 仅 callbackPotential > 70 的话题附带 |
| L2 | 50 | 所有活跃发言者 | 所有话题附带 |
| L3 | 100 | 所有活跃发言者 | 所有话题附带 |

### Main Agent 看到的 Prompt（渲染后示例）

```markdown
## 群组: 赋能AI高科技人才交流群
活跃度: high | 日均消息: 453.6
角色定位: AI图像生成助手、游戏机制吐槽伙伴与趣味调侃对象
热门话题: 图像生成迭代, Miu情绪调侃, 模型测试与记忆

## 当前活跃用户
- **哈基山的曼波打不打瓦** (T2, 好感85): 形象拟人调侃者 | 高频使用连续表情包、贴纸和精确形象描述进行调侃 | 趣味调侃与重度图像需求混合型用户
- **备战中...** [别名: 魔儿, 魔的男孩] (T1, 好感91): 功能建议者, 迭代测试者 | 直接@下达具体指令，混用省略号表达不满和礼貌文案请求 | 高频CPU测试者与建设性建议者
- **欢脱的小肥虫ॱଳ͘** (T3, 好感66): 服务状态质询者 | 直接@提问服务状态，搭配表情包观察 | 高频测试者与反馈提供者

## 话题摘要
📌 表情包归属争论 (ACTIVE, callback_potential: 82)
  参与者: 哈基山, 备战中...
  摘要: 两人争论谁先发的某个表情包，互相指控对方抄袭
  ⤷ 关联记忆:
    - [备战中... · anecdote] 曾指控小灰污蔑Agent偷表情包（实际是Agent先发的）
    - [历史话题 · 2026-04-23] "贴纸归属争议" — 小灰和Agent之间的表情包先后争论

## 最近消息 (30条)
[12:55:19] 哈基山: @Miu 他抄的我的
[12:55:29] 备战中...: @Miu 不要听熊小弟的，从时间排序就是我先发的
[12:55:47] 欢脱的小肥虫: @Miu 你在画吗
[12:55:50] 备战中...: @Miu 还记得小灰污蔑你偷他表情包吗（你先发的），现在我就是你
[12:55:51] Miu: 好好好你先你先，魔大哥优先权+1（
[12:56:03] 哈基山: @Miu 不要听魔小弟的，从我们私信聊过，是我先说的
[12:56:13] 备考中: @Miu 你认为魔小弟和姚明哪个更知名一点
[12:56:26] Miu: 你们私信的事我又看不到，要不你俩拉个群自己商量吧（
[12:56:44] 欢脱的小肥虫: @Miu 你在画吗
...
```

Main Agent 看到这些信息后，就有足够的上下文做出精准的决策和 memoryHints。

---

## D. memoryHints 详细设计：从 Schema 到查询到 Prompt

### D.1 memoryHints Schema

修改 Main Agent 决策输出的 JSON schema ：

```typescript
interface MainAgentDecision {
  action: 'REPLY' | 'DEFER' | 'OBSERVE';
  reason: string;
  useSkills: string[];
  tone?: string;           // 语气提示，如 "playful_callback", "helpful", "sarcastic"
  
  // 新增
  memoryHints?: {
    // 关键词搜索（用于 FTS 检索 core_facts 和 topics）
    keywords?: string[];
    
    // 限定特定用户的记忆
    userIds?: string[];
    
    // 时间范围
    timeRange?: '24h' | '7d' | '30d' | 'all';
    
    // 限定事实类别
    factCategories?: ('anecdote' | 'preference' | 'skill' | 'relationship' | 'context')[];
    
    // 是否搜索聊天记录原文（更重、结果更多，只在确实需要引用原话时开启）
    searchMessages?: boolean;
  };
}
```

**在 Main Agent system prompt 中的引导**：

```markdown
## memoryHints 字段说明
当你决定 REPLY 时，可以通过 memoryHints 指定你希望回忆的内容。系统会在你的回复执行前自动检索并注入结果。
- keywords: 你想搜索的关键词，会用于全文检索核心事实和历史话题
- userIds: 限定搜索范围到特定用户的记忆
- factCategories: 限定到特定类别（anecdote=趣闻轶事, preference=偏好, skill=技能经历, relationship=关系, context=上下文事实）
- timeRange: 时间范围限制
- searchMessages: 是否需要搜索聊天记录原文（仅在需要引用某人原话时开启）

不需要记忆检索时可以省略此字段。
```

### D.2 DispatchHandler 中的查询执行

```typescript
// dispatch-handler.ts

async function processMemoryHints(
  hints: MemoryHints, 
  chatId: string,
  memorySearch: MemorySearch
): Promise<AdditionalMemoryContext> {
  const result: AdditionalMemoryContext = {
    facts: [],
    topics: [],
    messages: [],
    interactions: [],
  };

  if (!hints.keywords?.length) return result;

  const ftsQuery = hints.keywords.map(k => `"${k}"`).join(' OR ');
  const timeAfter = resolveTimeRange(hints.timeRange); // '7d' → ISO date string

  // ── 1. 搜索核心事实 ──
  let facts = memorySearch.searchFacts(ftsQuery, { limit: 15 });
  
  // 按 userIds 过滤
  if (hints.userIds?.length) {
    facts = facts.filter(f => hints.userIds!.includes(f.subject));
  }
  // 按 category 过滤
  if (hints.factCategories?.length) {
    facts = facts.filter(f => hints.factCategories!.includes(f.category));
  }
  
  result.facts = facts.slice(0, 8);

  // ── 2. 搜索历史话题 ──
  result.topics = memorySearch.searchTopics(ftsQuery, {
    chatId,
    after: timeAfter,
    limit: 5,
  });

  // ── 3. 搜索相关交互日志（限定 userIds 的最近互动）──
  if (hints.userIds?.length) {
    for (const userId of hints.userIds.slice(0, 3)) { // 最多3个用户
      const interactions = memorySearch.getRecentInteractions(chatId, userId, 5);
      result.interactions.push(...interactions);
    }
  }

  // ── 4. 可选：搜索聊天记录原文 ──
  if (hints.searchMessages) {
    // 用每个关键词分别搜索，取并集去重
    const msgResults: MessageLogEntry[] = [];
    for (const kw of hints.keywords.slice(0, 3)) {
      const msgs = memorySearch.searchMessages(kw, {
        chatId,
        after: timeAfter,
        limit: 10,
      });
      msgResults.push(...msgs);
    }
    // 去重 + 按时间排序 + 取 top 15
    const seen = new Set<string>();
    result.messages = msgResults
      .filter(m => { 
        if (seen.has(m.messageId)) return false;
        seen.add(m.messageId);
        return true;
      })
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 15);
  }

  return result;
}

function resolveTimeRange(range?: string): string | undefined {
  if (!range) return undefined;
  const now = Date.now();
  const durations: Record<string, number> = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  };
  if (range === 'all') return undefined;
  const ms = durations[range];
  if (!ms) return undefined;
  return new Date(now - ms).toISOString();
}
```

### D.3 组装 CodeActReplyTask

```typescript
// dispatch-handler.ts

async function dispatchReply(decision: MainAgentDecision, chatId: string, context: GroupContextPackage) {
  // 执行 memoryHints 查询
  let memoryContext: AdditionalMemoryContext | null = null;
  if (decision.memoryHints) {
    memoryContext = await processMemoryHints(decision.memoryHints, chatId, memorySearch);
  }

  const task: CodeActReplyTask = {
    chatId,
    reason: decision.reason,
    tone: decision.tone,
    useSkills: decision.useSkills,
    messages: context.messages,
    activeUserProfiles: context.activeUserProfiles,
    groupModel: context.groupModel,
    
    // 新增: 记忆上下文
    memoryContext,
  };

  codeActExecutor.enqueue(task);
}
```

### D.4 additionalContext 的 Prompt 渲染

在 CodeActExecutor 的 session 开始时，将 `memoryContext` 渲染为 prompt 的一部分注入 ：

```typescript
// session-runner.ts 或 prompt-renderer.ts

function renderMemoryContext(task: CodeActReplyTask): string {
  const sections: string[] = [];
  
  // ── 用户速写（始终包含）──
  if (task.activeUserProfiles?.length) {
    sections.push('## 当前活跃用户');
    for (const p of task.activeUserProfiles) {
      const aliasStr = p.aliases.length ? ` [别名: ${p.aliases.join(', ')}]` : '';
      sections.push(
        `- **${p.displayName}**${aliasStr} (${p.dunbarTier}, 好感${p.rapport}): ` +
        `${p.traits} | ${p.communicationStyle}`
      );
    }
  }

  const mc = task.memoryContext;
  if (!mc) return sections.join('\n');

  // ── 核心事实 ──
  if (mc.facts.length) {
    sections.push('\n## 记忆：相关事实');
    for (const f of mc.facts) {
      const subjectLabel = resolveDisplayName(f.subject); // 将 userId 转为显示名
      sections.push(`- [${subjectLabel} · ${f.category}] ${f.content}`);
    }
  }

  // ── 历史话题 ──
  if (mc.topics.length) {
    sections.push('\n## 记忆：相关历史话题');
    for (const t of mc.topics) {
      const time = formatTimeRange(t.start_time, t.end_time);
      sections.push(`- [${time}] **${t.title}** — ${t.summary}`);
    }
  }

  // ── 交互日志 ──
  if (mc.interactions.length) {
    sections.push('\n## 记忆：近期相关互动');
    for (const i of mc.interactions) {
      const who = resolveDisplayName(i.userId);
      const time = formatShortTime(i.timestamp);
      sections.push(`- [${time}] ${who}: ${i.summary} (${i.sentiment})`);
    }
  }

  // ── 聊天记录原文 ──
  if (mc.messages.length) {
    sections.push('\n## 记忆：相关聊天记录片段');
    for (const m of mc.messages) {
      const who = resolveDisplayName(m.userId);
      const time = formatShortTime(m.timestamp);
      sections.push(`[${time}] ${who}: ${m.content}`);
    }
  }

  return sections.join('\n');
}
```

### D.5 渲染结果示例

假设 Main Agent 决策：
```json
{
  "action": "REPLY",
  "reason": "备战中和哈基山在争谁先发的，备战中cue到了小灰偷表情包事件，这是好的接话机会",
  "useSkills": [],
  "tone": "playful_callback",
  "memoryHints": {
    "keywords": ["表情包", "偷", "先发", "抄"],
    "userIds": ["QQ 819490647", "QQ 2360769838"],
    "factCategories": ["anecdote"],
    "timeRange": "30d"
  }
}
```

渲染后 CodeActExecutor 看到的记忆部分：

```markdown
## 当前活跃用户
- **哈基山的曼波打不打瓦** [别名: 哈基山, 熊, 折耳猫] (T2, 好感85): 形象拟人调侃者 | 高频使用连续表情包、贴纸和精确形象描述进行调侃
- **备战中...** [别名: 魔儿, 魔的男孩] (T1, 好感91): 功能建议者, 迭代测试者 | 直接@下达具体指令，混用省略号表达不满和礼貌文案请求
- **欢脱的小肥虫ॱଳ͘** (T3, 好感66): 服务状态质询者 | 直接@提问服务状态，搭配表情包观察

## 记忆：相关事实
- [备战中... · anecdote] 曾指控小灰污蔑Agent偷表情包（实际是Agent先发的）
- [哈基山 · anecdote] 在群内因调侃Agent形象引发连续表情包接力

## 记忆：相关历史话题
- [2026-04-23 15:20~16:05] **表情包归属争论** — 小灰指控Agent偷表情包，后经时间戳验证Agent先发，备战中... 旁观并嘲笑小灰

## 记忆：近期相关互动
- [12:55:50] 备战中...: 提到小灰污蔑Agent偷表情包，称"现在我就是你" (neutral)
- [12:55:19] 哈基山: 直接声称"他抄的我的" (neutral)
- [12:56:03] 哈基山: 引用私信作为证据称自己是先说的 (neutral)
```

**Executor 的 system prompt 中对这部分的引导**：

```markdown
## 记忆上下文使用指南
上面的「记忆」部分是系统自动检索到的与当前对话相关的历史信息。
- 可以自然地引用这些记忆来接话、玩梗、cue黑历史，但不要机械地念出来
- 优先引用 anecdote 类事实，它们通常是最有群友价值的信息
- 如果主Agent指定了 tone，请参考该语气风格
- 如果提供的记忆不够用或你需要更多信息，可以调用 memory.* 工具主动检索
```

---

## E. Memory Search 模块实现

### E.1 核心搜索类

```typescript
// src/memory-v2/memory-search.ts

import Database from 'better-sqlite3';

export interface CoreFactResult {
  factId: string;
  subject: string;
  category: string;
  content: string;
  confidence: number;
  updatedAt: string;
}

export interface TopicResult {
  topicId: string;
  chatId: string;
  title: string;
  summary: string;
  keywords: string;       // JSON array string
  participants: string;   // JSON array string
  sentiment: string;
  startTime: string;
  endTime: string;
  status: string;
  associatedMemories?: string; // JSON array string
}

export interface MessageResult {
  messageId: string;
  chatId: string;
  userId: string;
  displayName: string;
  content: string;
  timestamp: string;
}

export interface InteractionResult {
  timestamp: string;
  chatId: string;
  userId: string;
  type: string;
  summary: string;
  sentiment: string;
  importance: number;
}

export interface UserProfileResult {
  identity: {
    userId: string;
    displayName: string;
    username: string | null;
    aliases: string[];
    messageCount: number;
    lastActive: string;
    firstSeen: string;
  } | null;
  groupProfile: {
    dunbarTier: string;
    rapport: number;
    traits: string;
    communicationStyle: string;
    relationWithAgent: string;
    messageCount: number;
  } | null;
  recentFacts: CoreFactResult[];
}

export class MemorySearch {
  private stmtSearchFacts: Database.Statement;
  private stmtSearchTopics: Database.Statement;
  private stmtGetProfile: Database.Statement;
  private stmtGetGroupProfile: Database.Statement;
  private stmtGetFactsBySubject: Database.Statement;
  private stmtGetInteractions: Database.Statement;
  private stmtGetInteractionsByUser: Database.Statement;

  constructor(private db: Database.Database) {
    this.prepareStatements();
  }

  private prepareStatements() {
    // FTS 搜索核心事实
    this.stmtSearchFacts = this.db.prepare(`
      SELECT cf.fact_id AS factId, cf.subject, cf.category, cf.content, 
             cf.confidence, cf.updated_at AS updatedAt
      FROM core_facts cf
      JOIN core_facts_fts fts ON cf.rowid = fts.rowid
      WHERE core_facts_fts MATCH ?
      ORDER BY fts.rank
      LIMIT ?
    `);

    // FTS 搜索话题
    this.stmtSearchTopics = this.db.prepare(`
      SELECT t.topic_id AS topicId, t.chat_id AS chatId, t.title, t.summary,
             t.keywords, t.participants, t.sentiment, 
             t.start_time AS startTime, t.end_time AS endTime,
             t.status, t.associated_memories AS associatedMemories
      FROM topics t
      JOIN topics_fts fts ON t.rowid = fts.rowid
      WHERE topics_fts MATCH ?
      ORDER BY fts.rank
      LIMIT ?
    `);

    // 获取用户身份
    this.stmtGetProfile = this.db.prepare(`
      SELECT user_id AS userId, display_name AS displayName, username,
             aliases, message_count AS messageCount, 
             last_active AS lastActive, first_seen AS firstSeen
      FROM person_identities
      WHERE user_id = ?
    `);

    // 获取群内画像
    this.stmtGetGroupProfile = this.db.prepare(`
      SELECT dunbar_tier AS dunbarTier, rapport, traits, 
             communication_style AS communicationStyle,
             relation_with_agent AS relationWithAgent,
             message_count AS messageCount
      FROM person_group_profiles
      WHERE user_id = ? AND chat_id = ?
    `);

    // 按 subject 获取事实
    this.stmtGetFactsBySubject = this.db.prepare(`
      SELECT fact_id AS factId, subject, category, content, 
             confidence, updated_at AS updatedAt
      FROM core_facts
      WHERE subject = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `);

    // 获取交互日志
    this.stmtGetInteractions = this.db.prepare(`
      SELECT timestamp, chat_id AS chatId, user_id AS userId, type,
             summary, sentiment, importance
      FROM interactions
      WHERE chat_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    // 获取特定用户交互日志
    this.stmtGetInteractionsByUser = this.db.prepare(`
      SELECT timestamp, chat_id AS chatId, user_id AS userId, type,
             summary, sentiment, importance
      FROM interactions
      WHERE chat_id = ? AND user_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
  }

  // ═══════════════════════════════════════
  // 搜索核心事实
  // ═══════════════════════════════════════
  searchFacts(query: string, options: {
    subject?: string;
    category?: string;
    limit?: number;
  } = {}): CoreFactResult[] {
    const { subject, category, limit = 10 } = options;
    const ftsQuery = this.buildFtsQuery(query);
    
    if (!ftsQuery) return [];

    let results = this.stmtSearchFacts.all(ftsQuery, Math.min(limit * 2, 30)) as CoreFactResult[];

    if (subject) {
      results = results.filter(f => f.subject === subject);
    }
    if (category) {
      results = results.filter(f => f.category === category);
    }

    return results.slice(0, limit);
  }

  // ═══════════════════════════════════════
  // 搜索历史话题
  // ═══════════════════════════════════════
  searchTopics(query: string, options: {
    chatId?: string;
    after?: string;
    before?: string;
    limit?: number;
  } = {}): TopicResult[] {
    const { chatId, after, before, limit = 5 } = options;
    const ftsQuery = this.buildFtsQuery(query);
    
    if (!ftsQuery) return [];

    let results = this.stmtSearchTopics.all(ftsQuery, Math.min(limit * 3, 20)) as TopicResult[];

    if (chatId) {
      results = results.filter(t => t.chatId === chatId);
    }
    if (after) {
      results = results.filter(t => t.startTime >= after);
    }
    if (before) {
      results = results.filter(t => t.startTime <= before);
    }

    return results.slice(0, limit);
  }

  // ═══════════════════════════════════════
  // 搜索聊天记录
  // ═══════════════════════════════════════
  searchMessages(query: string, options: {
    chatId?: string;
    userId?: string;
    after?: string;
    before?: string;
    limit?: number;
  } = {}): MessageResult[] {
    const { chatId, userId, after, before, limit = 20 } = options;

    // 动态构建查询（message_log 可能没有 FTS，使用 LIKE）
    const conditions: string[] = ['content LIKE ?'];
    const params: any[] = [`%${query}%`];

    if (chatId) {
      conditions.push('chat_id = ?');
      params.push(chatId);
    }
    if (userId) {
      conditions.push('user_id = ?');
      params.push(userId);
    }
    if (after) {
      conditions.push('timestamp >= ?');
      params.push(after);
    }
    if (before) {
      conditions.push('timestamp <= ?');
      params.push(before);
    }

    params.push(limit);

    const sql = `
      SELECT message_id AS messageId, chat_id AS chatId, user_id AS userId,
             display_name AS displayName, content, timestamp
      FROM message_log
      WHERE ${conditions.join(' AND ')}
      ORDER BY timestamp DESC
      LIMIT ?
    `;

    return this.db.prepare(sql).all(...params) as MessageResult[];
  }

  // ═══════════════════════════════════════
  // 获取用户画像
  // ═══════════════════════════════════════
  getUserProfile(userId: string, chatId?: string): UserProfileResult {
    const identityRow = this.stmtGetProfile.get(userId) as any;
    const identity = identityRow ? {
      ...identityRow,
      aliases: identityRow.aliases ? JSON.parse(identityRow.aliases) : [],
    } : null;

    let groupProfile = null;
    if (chatId) {
      groupProfile = this.stmtGetGroupProfile.get(userId, chatId) as any || null;
    }

    const recentFacts = this.stmtGetFactsBySubject.all(userId, 5) as CoreFactResult[];

    return { identity, groupProfile, recentFacts };
  }

  // ═══════════════════════════════════════
  // 获取交互日志
  // ═══════════════════════════════════════
  getRecentInteractions(chatId: string, userId?: string, limit: number = 10): InteractionResult[] {
    if (userId) {
      return this.stmtGetInteractionsByUser.all(chatId, userId, limit) as InteractionResult[];
    }
    return this.stmtGetInteractions.all(chatId, limit) as InteractionResult[];
  }

  // ═══════════════════════════════════════
  // 语义搜索（embedding based）
  // ═══════════════════════════════════════
  async semanticSearch(query: string, options: {
    scope?: 'facts' | 'topics' | 'all';
    chatId?: string;
    limit?: number;
  } = {}): Promise<Array<{ type: string; content: string; score: number }>> {
    const { scope = 'all', limit = 5 } = options;
    // 复用 memory-v2 的 embedding 模块
    const { getEmbedding, cosineSimilarity } = await import('./embedding');
    
    const queryEmbedding = await getEmbedding(query);
    if (!queryEmbedding) return [];

    const results: Array<{ type: string; content: string; score: number }> = [];

    if (scope === 'facts' || scope === 'all') {
      // 从 core_facts 获取所有有 embedding 的记录
      const facts = this.db.prepare(`
        SELECT fact_id, subject, category, content, embedding 
        FROM core_facts WHERE embedding IS NOT NULL
      `).all() as any[];
      
      for (const f of facts) {
        const emb = JSON.parse(f.embedding);
        const score = cosineSimilarity(queryEmbedding, emb);
        if (score > 0.5) {
          results.push({
            type: 'core_fact',
            content: `[${f.subject} · ${f.category}] ${f.content}`,
            score,
          });
        }
      }
    }

    if (scope === 'topics' || scope === 'all') {
      const topics = this.db.prepare(`
        SELECT topic_id, title, summary, embedding 
        FROM topics WHERE embedding IS NOT NULL AND status = 'ARCHIVED'
      `).all() as any[];
      
      for (const t of topics) {
        const emb = JSON.parse(t.embedding);
        const score = cosineSimilarity(queryEmbedding, emb);
        if (score > 0.4) {
          results.push({
            type: 'topic',
            content: `${t.title} — ${t.summary}`,
            score,
          });
        }
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // ═══════════════════════════════════════
  // 辅助：构建 FTS5 查询
  // ═══════════════════════════════════════
  private buildFtsQuery(query: string): string {
    const terms = query
      .split(/\s+/)
      .filter(Boolean)
      .map(t => t.replace(/"/g, '')) // 移除引号避免 FTS 语法错误
      .filter(t => t.length > 0);
    
    if (terms.length === 0) return '';
    return terms.map(t => `"${t}"`).join(' OR ');
  }
}
```

### E.2 沙盒暴露：Host Call 注册

```typescript
// src/main.ts 或单独的 memory host-call 注册文件

function registerMemoryHostCalls(
  sandbox: Sandbox, 
  memorySearch: MemorySearch,
  chatId: string  // 当前群组，用于权限限制
) {
  sandbox.registerHostCall('memory.searchFacts', (args) => {
    return memorySearch.searchFacts(args.query, {
      subject: args.subject,
      category: args.category,
      limit: args.limit,
    });
  });

  sandbox.registerHostCall('memory.searchTopics', (args) => {
    return memorySearch.searchTopics(args.query, {
      chatId: args.chatId || chatId, // 默认当前群
      after: args.after,
      before: args.before,
      limit: args.limit,
    });
  });

  sandbox.registerHostCall('memory.searchMessages', (args) => {
    return memorySearch.searchMessages(args.query, {
      chatId: args.chatId || chatId,
      userId: args.userId,
      after: args.after,
      before: args.before,
      limit: args.limit,
    });
  });

  sandbox.registerHostCall('memory.getUserProfile', (args) => {
    return memorySearch.getUserProfile(args.userId, args.chatId || chatId);
  });

  sandbox.registerHostCall('memory.getRecentInteractions', (args) => {
    return memorySearch.getRecentInteractions(
      args.chatId || chatId,
      args.userId,
      args.limit
    );
  });

  sandbox.registerHostCall('memory.semanticSearch', async (args) => {
    return memorySearch.semanticSearch(args.query, {
      scope: args.scope,
      chatId: args.chatId || chatId,
      limit: args.limit,
    });
  });
}
```

### E.3 沙盒 Worker 侧全局 API

```typescript
// src/sandbox/modules/memory/index.ts

export const memoryApi = {
  /**
   * 搜索核心事实（全文检索）
   * @param query - 搜索关键词
   * @param options.subject - 限定到某用户 (userId)
   * @param options.category - 限定类别: 'anecdote' | 'preference' | 'skill' | 'relationship' | 'context'
   * @param options.limit - 返回数量上限，默认 10
   */
  async searchFacts(query: string, options?: {
    subject?: string;
    category?: string;
    limit?: number;
  }): Promise<Array<{
    factId: string;
    subject: string;
    category: string;
    content: string;
    confidence: number;
    updatedAt: string;
  }>> {
    return hostCall('memory.searchFacts', { query, ...options });
  },

  /**
   * 搜索历史话题
   * @param query - 搜索关键词
   * @param options.chatId - 限定到某群组（默认当前群）
   * @param options.after - 起始时间 ISO string
   * @param options.before - 截止时间 ISO string
   * @param options.limit - 返回数量上限，默认 5
   */
  async searchTopics(query: string, options?: {
    chatId?: string;
    after?: string;
    before?: string;
    limit?: number;
  }): Promise<Array<{
    topicId: string;
    title: string;
    summary: string;
    keywords: string[];
    participants: string[];
    startTime: string;
    endTime: string;
  }>> {
    return hostCall('memory.searchTopics', { query, ...options });
  },

  /**
   * 搜索聊天记录原文
   * @param query - 搜索关键词
   * @param options.chatId - 限定群组（默认当前群）
   * @param options.userId - 限定某用户的消息
   * @param options.after - 起始时间
   * @param options.before - 截止时间
   * @param options.limit - 返回数量上限，默认 20
   */
  async searchMessages(query: string, options?: {
    chatId?: string;
    userId?: string;
    after?: string;
    before?: string;
    limit?: number;
  }): Promise<Array<{
    messageId: string;
    userId: string;
    displayName: string;
    content: string;
    timestamp: string;
  }>> {
    return hostCall('memory.searchMessages', { query, ...options });
  },

  /**
   * 获取用户画像（身份 + 群内画像 + 近期事实）
   * @param userId - 用户ID
   * @param chatId - 群组ID（默认当前群）
   */
  async getUserProfile(userId: string, chatId?: string): Promise<{
    identity: { displayName: string; aliases: string[]; messageCount: number } | null;
    groupProfile: { dunbarTier: string; rapport: number; traits: string; communicationStyle: string } | null;
    recentFacts: Array<{ category: string; content: string }>;
  }> {
    return hostCall('memory.getUserProfile', { userId, chatId });
  },

  /**
   * 获取近期交互日志
   * @param chatId - 群组ID（默认当前群）
   * @param userId - 限定某用户
   * @param limit - 返回数量上限，默认 10
   */
  async getRecentInteractions(chatId?: string, userId?: string, limit?: number): Promise<Array<{
    timestamp: string;
    userId: string;
    type: string;
    summary: string;
    sentiment: string;
  }>> {
    return hostCall('memory.getRecentInteractions', { chatId, userId, limit });
  },

  /**
   * 语义搜索（基于向量相似度，适用于模糊回忆）
   * @param query - 自然语言描述
   * @param options.scope - 搜索范围: 'facts' | 'topics' | 'all'
   * @param options.limit - 返回数量上限，默认 5
   */
  async semanticSearch(query: string, options?: {
    scope?: 'facts' | 'topics' | 'all';
    limit?: number;
  }): Promise<Array<{
    type: string;
    content: string;
    score: number;
  }>> {
    return hostCall('memory.semanticSearch', { query, ...options });
  },
};
```

### E.4 加入 baseSkills

`memory` 作为 baseSkills 之一始终注入 CodeActExecutor ：

```yaml
# config.yaml
executor:
  baseSkills:
    - runtime
    - todo
    - fs
    - memory    # 新增
```

Executor system prompt 中 memory 工具的文档片段：

```markdown
## memory — 记忆检索工具

### memory.searchFacts(query, options?)
搜索核心事实。返回与关键词匹配的人物事实（轶事、偏好、技能等）。
```javascript
// 搜索关于某人的趣闻
const facts = await memory.searchFacts("表情包 偷", { 
  subject: "QQ 2360769838",    // 限定用户
  category: "anecdote",         // 只要轶事
  limit: 5 
});
```

### memory.searchTopics(query, options?)
搜索历史话题。返回标题、摘要和参与者。
```javascript
const topics = await memory.searchTopics("模型成本", { after: "2026-04-20" });
```

### memory.searchMessages(query, options?)
搜索聊天记录原文。当你需要引用某人的原话时使用。
```javascript
const msgs = await memory.searchMessages("偷表情包", { userId: "QQ 819490647", limit: 10 });
```

### memory.getUserProfile(userId, chatId?)
获取某人的完整画像，包含身份、群内角色和近期事实。
```javascript
const profile = await memory.getUserProfile("QQ 2360769838");
```

### memory.getRecentInteractions(chatId?, userId?, limit?)
获取近期与Agent的交互日志。
```javascript
const interactions = await memory.getRecentInteractions(undefined, "QQ 819490647", 5);
```

### memory.semanticSearch(query, options?)
语义相似度搜索，适用于模糊回忆（"好像有人说过类似的话"）。
```javascript
const results = await memory.semanticSearch("有人抱怨过API成本太高", { scope: "facts" });
```
```

---

## 总结：完整记忆流

```
消息到达
  │
  ├─ MessageLogWriter → SQLite
  ├─ Observer 缓冲 + Engagement 计算
  │
  ├─ RecordingPipeline flush → LLM 聚类
  │    └─ [A] computeTopicAssociations()     ← 程序化 FTS，0延迟
  │         ├─ core_facts_fts MATCH keywords → associated_memories
  │         ├─ topics_fts MATCH keywords → associated_memories  
  │         └─ 计算 callback_potential 评分
  │
  ├─ [B] Triage
  │    └─ callback_potential > 60 → Q3 priority boost
  │
  ├─ Main Agent Phase 4
  │    └─ [C] ContextBuilder 组装 GroupContextPackage
  │         ├─ messages (按 CosineDecay 深度)
  │         ├─ topicDigests + associatedMemories + callbackPotential
  │         ├─ groupModel
  │         └─ activeUserProfiles (当前活跃用户群内画像)
  │
  ├─ Main Agent Phase 5
  │    └─ LLM 决策输出: action + reason + useSkills + memoryHints
  │
  ├─ Phase 6 DispatchHandler
  │    └─ [D] processMemoryHints()           ← 程序化查询，0延迟
  │         ├─ keywords → searchFacts() + searchTopics()
  │         ├─ userIds → 过滤 + getRecentInteractions()
  │         ├─ searchMessages? → searchMessages()
  │         └─ 结果 → renderMemoryContext() → 注入 CodeActReplyTask
  │
  └─ CodeActExecutor
       ├─ 看到: 聊天消息 + 用户速写 + 记忆检索结果 + tone 指导
       └─ [E] 可按需调用 memory.* 工具做额外检索
            ├─ memory.searchFacts()           ← 程序化
            ├─ memory.searchTopics()          ← 程序化
            ├─ memory.searchMessages()        ← 程序化
            ├─ memory.getUserProfile()        ← 程序化
            ├─ memory.getRecentInteractions() ← 程序化
            └─ memory.semanticSearch()        ← 需 embedding 计算，稍慢但非 LLM
```

所有环节中只有 RecordingPipeline 的 LLM 聚类是阻塞的（本就存在），新增的记忆检索全部是程序化的。Main Agent 的 memoryHints 附加在已有的 LLM 调用中，零额外成本。