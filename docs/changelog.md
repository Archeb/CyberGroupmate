# Changelog

## 2026-03-21: Refactor dashboard frontend to Svelte

### Overview

Migrated the monolithic dashboard frontend (~2850 lines in `app.js` + `index.html` + `style.css`) to a modular **Svelte 5 + Vite + TailwindCSS 4 + DaisyUI 5** SPA. No backend changes required.

### New: `src/dashboard/ui/`

| Category | Files |
|----------|-------|
| Build config | `package.json`, `vite.config.js`, `svelte.config.js`, `index.html` |
| Entry | `src/main.js`, `src/App.svelte`, `src/app.css` |
| Core libs | `src/lib/api.js` (REST + token), `ws.js` (WebSocket + reconnect), `stores.js` (Svelte stores), `utils.js` (shared utils) |
| Layout | `Navbar.svelte`, `StatsBar.svelte`, `TabNav.svelte` |
| Panels (10) | `MessagesPanel`, `TopicsPanel`, `QueuePanel`, `DecisionsPanel`, `CodeActPanel`, `LLMLogPanel`, `MemoryPanel`, `StickersPanel`, `SystemPanel`, `TopicDetailPanel` |
| Memory sub-tabs (6) | `PersonsTab`, `ProfilesTab`, `GroupsTab`, `FactsTab`, `InteractionsTab`, `RecallTab` |
| Modals | `EnqueueModal.svelte`, `MemoryEditModal.svelte` |

### Modified

| File | Change |
|------|--------|
| `.gitignore` | Added `src/dashboard/public/`, `src/dashboard/ui/node_modules/` |
| `package.json` | Added `dashboard:dev`, `dashboard:build` scripts |
| `Dockerfile` | Added `ui-build` stage for Svelte compilation |
| `.vscode/launch.json` | Added `🖥️ Dashboard Dev Server (Vite)` + compound `🚀+🖥️ Agent + Dashboard Dev` |

### CSS modularization

Component-specific styles moved from global `app.css` into scoped `<style>` blocks: `LLMLogPanel`, `MessagesPanel`, `TopicsPanel`, `QueuePanel`, `DecisionsPanel`. Global `app.css` reduced from 466 → 168 lines (tab-nav, codeact, scrollbar, JSON, clickable utilities remain global).

### Build output

- 148 modules, ~771ms build time
- CSS: 77.74 kB (gzip 14.24 kB), JS: 159.21 kB (gzip 54.31 kB)

## 2026-03-20: 修复 Observer Alert 重复触发导致 Token 快速消耗

### Bug

Observer alert 每 5 秒触发一次 attend-handler 的 LLM 调用，即使群组没有任何新消息。LLM 每次审视后都返回"不回复"，但仍然消耗 token。一个活跃群在 5 分钟窗口内可被 attend 60+ 次。

**根因**：之前一次修改让 `clearBuffer()` 不再清零 `messageTimestamps`/`recentSenders`/`cachedEngagement`（理由是"基于时间窗口自然衰减"），偏离了 `subagent.md` §4.5 的设计意图。结果 engagement 在 5 分钟窗口内持续 ≥ 60（alert 阈值），每个 tick 都会重新入队并调用 LLM。配套的 30s `ATTEND_COOLDOWN_MS` 只能部分缓解——cooldown 过后又会被重新入队。

### 修复方案

回归 `subagent.md` §4.5 的设计：**attend 后清零 engagement 状态**。这样群组只在有新消息累积到阈值后才会重新触发 alert。同时移除不再需要的 cooldown 机制。

### 改动

| 文件 | 改动 |
|------|------|
| `src/subagent/observer.ts` | `clearBuffer()` 恢复清零 `messageTimestamps`、`recentSenders`、`cachedEngagement` |
| `src/subagent/group-subagent.ts` | 移除 `ATTEND_COOLDOWN_MS`、`lastAttendedAtMs`、`isInAttendCooldown()` |
| `src/main-agent/main-agent-loop.ts` | Phase 2 移除 cooldown 守卫 |
| `src/main.ts` | `nc.onPush` 移除 cooldown 守卫，alert 直接生效 |

净效果：4 文件，+11 -27 行。

## 2026-03-21: 移除 Observer Alert 入队路径 + 同 tick 防重复 attend

### Bug

上一个修复（清零 engagement）后，活跃群仍然频繁被 attend：新消息每几秒到达就重新累积 engagement ≥ 60 → 触发 alert → 入队 → LLM 返回 NONE → 浪费 token。同时 LLM 调用期间（~7s）新消息到达会导致同一群在同一 tick 内被 attend 两次。

**根因**：OBSERVER_ALERT（纯 engagement 阈值）作为 Q3 入队触发本身就有设计缺陷——engagement 高只代表群活跃，不代表机器人需要关注。已有 triage-engage（内容级 LLM 判断）和 @mention/DM（直接寻址）两条正确的入队路径。

### 修复方案

1. **移除 OBSERVER_ALERT 入队路径**：engagement 仅用于 Q3 内部优先级排序，不再作为入队触发条件
2. **同 tick 防重复**：Phase 3 循环中记录已 attend 的 chatId，跳过重复

### 改动

| 文件 | 改动 |
|------|------|
| `src/main-agent/main-agent-loop.ts` | Phase 2 移除 alert 入队/boost；Phase 3 加 `attendedThisTick` 去重；移除 `boostedAlerts` |
| `src/main.ts` | `nc.onPush` 移除 alert 入队，仅保留 DM/@mention/文本提及 |

## 2026-03-21: 修复 topicDigests 始终为空 & dispatchedTopicIds 含虚假 ID

### Bug

1. **topicDigests 始终 "(无活跃话题)"**：Observer 的 `topicDigests` 仅在 RecordingPipeline fire `topic:triage-passed` 后才写入。路径 1（DM/mention/文本提及）在 pipeline flush 之前就入队并 attend，`observer.getDigest()` 必然为空。
2. **dispatchedTopicIds 含非标准 ID**：topicDigests 为空时 LLM 照着 prompt 示例编造 `topic_xxx` 等假 ID，`dispatch-handler` 不验证就写入 `dispatchedTopicIds`。

### 修复方案

- `buildQueueEntry()` fallback：Observer 无 digest 时从 TopicRegistry 生成快照
- attend 后立即触发 `recordingPipeline.flush()`，确保话题聚类及时更新
- `markTopicDispatched` 前校验 topicId 是否存在于 TopicRegistry
- decision prompt 明确禁止 LLM 编造 topicId

### 改动

| 文件 | 改动 |
|------|------|
| `src/subagent/group-subagent.ts` | `buildQueueEntry()` 增加 TopicRegistry fallback |
| `src/main-agent/main-agent-loop.ts` | attend 后触发 `recordingPipeline.flush()` |
| `src/main-agent/dispatch-handler.ts` | `markTopicDispatched` 前验证 topicId 合法性 |
| `system-prompts/subagent-decision.md` | 禁止 LLM 编造 topicId |

### Refactor: 统一话题列表渲染逻辑

提取共享函数 `formatTopicList` / `formatRelativeTime` 到 `prompt-renderer.ts`，attention prompt 和 execution task prompt 共用同一渲染逻辑。

| 文件 | 改动 |
|------|------|
| `src/main-agent/prompt-renderer.ts` | 新增 `FormattableTopic`、`formatRelativeTime`、`formatTopicList`；`formatTopicDigests` 委托 |
| `src/main-agent/dispatch-handler.ts` | 移除本地 `formatRelativeTime`，改用 `formatTopicList` |

### Fix: attend 后 flush 仅聚类不 triage

`flush()` 新增 `{ clusterOnly: true }` 选项。post-attend flush 跳过 Step 2 triage LLM 调用——刚回复过的话题不需要重新判断"要不要介入"，节省 cheap model token。

| 文件 | 改动 |
|------|------|
| `src/pipeline/recording-pipeline.ts` | `flush()` 新增 `clusterOnly` 参数，跳过 triage |
| `src/main-agent/main-agent-loop.ts` | post-attend flush 使用 `{ clusterOnly: true }` |

### Refactor: Q3 来源标记 + CODEACT_REPLY 上下文增强 + attend-handler 简化

1. **`DIRECT_ADDRESS` 来源标记**：DM/mention/keyword 入队源和 triage-engage 入队源现在有独立标记
2. **Decision 增加 `targetMessageIds` / `toneGuidance`**：LLM 输出的目标消息 ID 和语气指导层层传递到执行层
3. **attend-handler 移除全部算法预估和 fallback**：不再使用 `estimateReplyMode`、`buildReplyDecisions`，LLM 失败直接返回 OBSERVE
4. **personContext 移至 code-act-executor**：从 recentMessages 发言者精准查询画像，替代空 `recall(""))` 的随机结果

| 文件 | 改动 |
|------|------|
| `src/subagent/types.ts` | `source` 新增 `DIRECT_ADDRESS`；`Decision` 增加 `targetMessageIds`/`toneGuidance` |
| `src/subagent/group-subagent.ts` | `buildQueueEntry()` 接受 `sourceOverride` 参数 |
| `src/main.ts` | DM/mention/keyword 路径传入 `DIRECT_ADDRESS` |
| `src/main-agent/attend-handler.ts` | 移除 decision-maker 依赖及全部算法逻辑；解析 LLM 输出的新字段 |
| `src/main-agent/dispatch-handler.ts` | 移除 personContext 查询；传递 `targetMessageIds`/`toneGuidance` |
| `src/subagent/code-act-executor.ts` | 新增 personContext 查询：从 recentMessages 发言者匹配群内画像 |
