# Changelog

## 2026-03-21: LLM Prefill + Stop Sequences 支持

新增 LLM 调用层面的 **assistant prefill**（预填充回复开头）和 **stop sequences**（停止生成序列）支持，用于引导模型思考方向和控制输出边界。

### Prefill

在消息列表末尾追加一条 `role=assistant` 消息作为生成起点，返回的 `content` 自动拼接 prefill 前缀，调用方拿到完整文本。

- `session-runner` → `让{{name}}想想，`（引导 CodeAct 以角色身份思考）
- `attend-handler` → `让{{name}}看看，`（引导注意力决策）

### Stop Sequences

LLM 遇到指定字符串时停止生成。OpenAI 使用 `stop` 字段，Anthropic 使用 `stop_sequences` 字段。

- `session-runner` → `["系统返回】**"]`

### 兼容性

部分模型不支持 prefill，可在 `llm_profiles` 中设置 `supports_prefill: false` 关闭（默认 `true`）。

```yaml
llm_profiles:
  openai-gpt4o:
    supports_prefill: false  # 原版 OpenAI 不支持 prefill
```

### 改动

| 文件 | 改动 |
|------|------|
| `src/core/llm.ts` | `LLMCallOptions` 新增 `prefill?`/`stop?`；`callLLM` 按 `supportsPrefill` 决定是否应用；`callOpenAI`/`callAnthropic` 追加 assistant 消息 + stop 字段；返回值自动拼接 prefill 前缀 |
| `src/core/config.ts` | `LLMConfig` 新增 `supportsPrefill?: boolean`；`parseLLMProfile` 解析 `supports_prefill` |
| `src/sandbox/session-runner.ts` | `runCodeActSession` 新增 `prefill`/`stopSequences` 可选参数，传给 `callLLMWithFallback` |
| `src/subagent/code-act-executor.ts` | 调用处传入 prefill `让${personaName}想想，` + stop `["系统返回】**"]` |
| `src/main-agent/attend-handler.ts` | 调用处传入 prefill `让${persona.name}看看，`；JSON 解析增强以兼容 prefill 前缀 |
| `config.example.yaml` | 新增 `supports_prefill` 配置说明 |

## 2026-03-21: Token 用量与费用统计

新增 Dashboard Token 费用追踪功能：支持 per-profile 价格配置、OpenAI/Anthropic 缓存 token 解析、持久化按模型统计、独立统计面板。

### 价格配置

在 `llm_profiles` 中为每个 profile 添加可选 `pricing` 字段（每百万 token，USD）：

```yaml
llm_profiles:
  gemini-flash:
    model: gemini-3-flash-preview
    pricing:
      input: 0.15
      output: 0.60
      cached_input: 0.0375
  claude:
    model: claude-sonnet-4-20250514
    pricing:
      input: 3.00
      output: 15.00
      cached_input: 0.30
      cache_creation: 3.75    # Anthropic 特有
```

### 改动

| 文件 | 改动 |
|------|------|
| `src/core/llm.ts` | `LLMResponse.usage` 新增 `cachedTokens`/`cacheCreationTokens`；OpenAI 解析 `prompt_tokens_details.cached_tokens`，Anthropic 解析 `cache_read_input_tokens`/`cache_creation_input_tokens` |
| `src/core/config.ts` | `LLMConfig` 新增 `pricing?` 子对象；`TokenPricingEntry` 类型导出；`parseLLMProfile` 解析 pricing |
| `src/dashboard/token-stats.ts` | **[NEW]** `TokenStatsCollector` — 按模型持久化统计（`workspace/token-stats.json`），30s debounce 写入；`calculateCallCost()` 费用计算 |
| `src/dashboard/types.ts` | `DashboardDeps` 新增 `tokenStats` |
| `src/dashboard/event-bridge.ts` | `llm:response` 时调用 `tokenStats.record()`；snapshot 包含 `tokenPricing` |
| `src/dashboard/api-routes.ts` | 新增 `GET /token-stats`、`POST /token-stats/reset`、`GET /token-pricing` |
| `src/main.ts` | 创建 `TokenStatsCollector` 并注入 Dashboard |
| `src/dashboard/ui/src/lib/stores.js` | 新增 `tokenPricing` store、`calculateCallCost()`、`setTokenPricing()`；`llmStats` 增加 `totalCost` |
| `src/dashboard/ui/src/lib/ws.js` | snapshot 时设置 tokenPricing |
| `src/dashboard/ui/src/panels/LLMLogPanel.svelte` | 工具栏显示会话总费用；列表行显示单笔费用；详情显示 cached/cacheCreation token 明细 + 费用 |
| `src/dashboard/ui/src/panels/TokenStatsPanel.svelte` | **[NEW]** 独立面板：汇总卡片 + 按模型统计表 + 清零按钮 |
| `src/dashboard/ui/src/components/TabNav.svelte` | 新增「Token 统计」tab |
| `src/dashboard/ui/src/App.svelte` | 注册 TokenStatsPanel |
| `config.example.yaml` | 各 profile 示例中添加 `pricing` 注释 |

## 2026-03-21: 组件级 LLM 路由（替代 model_tiers）

移除 `model_tiers`（cheap/mid/sota）配置，替换为按组件粒度的 `llm_routing`。每个组件可独立指定 LLM profile，支持单个或数组（fallback chain）。

**8 个路由键**：`attend`（注意力决策）、`session`（CodeAct 交互）、`fast_path`（快速回复）、`recording`（话题聚类）、`reflection`（反思引擎）、`compact`（上下文压缩）、`memory`（记忆检索）、`vision`（图片描述，独立配置）。

```yaml
llm_routing:
  attend: gemini-flash
  session: gemini-pro       # 或 [gemini-pro, gemini-flash] fallback
  fast_path: gemini-flash
  recording: gemini-flash
  reflection: gemini-flash
  compact: gemini-flash
  memory: gemini-flash
  vision: gemini-flash
```

### 改动

| 文件 | 改动 |
|------|------|
| `src/core/config.ts` | `ModelTiersConfig` → `LLMRoutingConfig`；`resolveTierProfile`/`resolveTierProfiles` → `resolveComponentProfiles` |
| `src/main.ts` | 按组件解析 LLM 配置，传递给各子系统 |
| `src/main-agent/dispatch-handler.ts` | `cheapConfig` → `fastPathConfig`；vision 路由改用 `llmRouting.vision` |
| `src/cli.ts` | `config` 命令显示组件路由 |
| `config.yaml` | `model_tiers` → `llm_routing` |
| `config.example.yaml` | 同上 |

## 2026-03-21: 全深度消息获取 + 移除 noMessages 机制

消息获取不再受 cosine decay 深度限制。所有深度级别均提供消息原文，数量随深度递增：L0=10、L1=30、L2=50、L3=100（旧值：L0=0、L1=5、L2=20）。移除 `hasMessages`/`noMessages` 模板变量和条件块。

| 文件 | 改动 |
|------|------|
| `src/main-agent/attend-handler.ts` | `messageLimit` 公式改为全深度覆盖；移除 `depth >= 2` 消息构建门控 |
| `src/main-agent/context-builder.ts` | 移除 `depth >= 1` 的 messages 注入门控 |
| `src/main-agent/prompt-renderer.ts` | 移除 `hasMessages`/`noMessages` 变量 |
| `system-prompts/subagent-attention.md` | 移除 `{{#hasMessages}}`/`{{#noMessages}}` 条件块 |

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
