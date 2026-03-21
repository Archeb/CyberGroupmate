# Changelog

## 2026-03-21: 贴纸发送功能 + sendSticker API

完整的贴纸发送管线：贴纸 webp 文件永久保存到本地 → LLM 决策时输出相关 emoji → 按 emoji 查找可用贴纸 → 注入 CodeAct 上下文 → bot 通过 `sendSticker(chatId, uniqueFileId)` 发送。

### 贴纸存储与保留

- `vision-processor.ts` 处理贴纸时调用 `mediaDownloader.saveMedia` 将 webp 文件保存到 `workspace/Downloads/stickers/`
- `media-downloader.ts` 的 `cleanupExpired()` 跳过 `stickers/` 目录，贴纸文件永久保留
- 使用 `uniqueFileId` 作为贴纸索引键

### 贴纸查找与上下文注入

- `memory-v2.ts` 新增 `searchStickersByEmoji(emojis[])` 和 `deleteStickerDescription()`
- `types.ts` 的 `Decision` 新增 `suggestedEmojis?: string[]`；`GroupContextPackage` 新增 `availableStickers`（emoji + description + uniqueFileId）
- `attend-handler.ts` 解析 LLM 输出的 `suggestedEmojis`
- `dispatch-handler.ts` 按 emoji 查找贴纸 → 验证文件存在（`fs.existsSync`）→ 清理过期 DB 条目 → 注入 `availableStickers` 到 `contextSnapshot`
- `subagent-decision.md` 新增 `suggestedEmojis` 字段规则
- `subagent-execution-task.md` 新增可用贴纸段落

### sendSticker API

`sendSticker(chatId, uniqueFileId)` —— 专用贴纸发送函数，host 侧解析 uniqueFileId → 本地文件路径 → 读取 buffer → 通过 mtcute `sendMedia({type:'sticker', file: buffer})` 发送。

| 文件 | 改动 |
|------|------|
| `src/main.ts` | 共享 `MediaDownloader` 实例；`telegram.sendSticker` host call 拦截器（uniqueFileId → 文件路径 → buffer → sendMedia） |
| `src/sandbox/modules/telegram.ts` | `sendSticker` 代理方法：重复发送拦截 + `agent_message_sent` 事件 |
| `src/sandbox/modules/telegram.d.ts` | 新增 `sendSticker(chatId, uniqueFileId, opts?)` 类型定义 |
| `src/adapter/telegram-adapter.ts` | `sendMedia` 支持本地文件路径（非 sticker）；`sendSticker` 加入 mute 屏蔽列表 |

### Dashboard 贴纸预览

| 文件 | 改动 |
|------|------|
| `src/dashboard/api-routes.ts` | 新增 `GET /stickers/:uniqueFileId/image`；`GET /stickers` 新增 `hasImage` 字段 |
| `src/dashboard/types.ts` | `DashboardDeps` 新增 `mediaDownloader` |
| `src/dashboard/ui/src/panels/StickersPanel.svelte` | 48×48 贴纸缩略图预览列 |
| `src/dashboard/ui/src/lib/api.js` | 新增 `apiBase()` 辅助函数 |

### Bug Fix: 贴纸标签重复

`message-enricher.ts` 的 `formatMessageLine` 和 `formatMessages` 中，当 `m.text` 已包含媒体标签时（Telegram adapter 在 `event.text` 中预设），不再通过 `mediaTagFromType` 重复追加。

## 2026-03-21: CodeActPanel 实时流式更新 & 侧栏样式修复

CodeActPanel 从轮询 REST API 改为 **WebSocket 实时推送**，每轮 LLM 思考和代码执行结果 **即时显示**，不再需要等 session 完成。侧栏群组列表样式统一为 MessagesPanel 的 `button` + `chatTitle` + 动画效果。

### 架构

新增全局 `codeActEvents` EventEmitter（与 `llmEvents` 同模式），`session-runner.ts` 在每轮 thinking / observation / end / error 时 emit 进度事件，`event-bridge.ts` 订阅并广播 `codeact:progress` 到 WebSocket，前端 store 接收后实时渲染。

### 改动

| 文件 | 改动 |
|------|------|
| `src/sandbox/session-runner.ts` | 新增 `codeActEvents` EventEmitter + `CodeActProgressEvent` 类型；`runCodeActSession` 新增 `chatId` 参数；每轮 thinking/observation/end/error 时 emit 进度事件 |
| `src/subagent/code-act-executor.ts` | 调用 `runCodeActSession` 时传入 `this.chatId` |
| `src/dashboard/event-bridge.ts` | 新增 `hookCodeActEvents()` 订阅全局 emitter，广播 `codeact:progress` |
| `src/dashboard/ui/src/lib/stores.js` | 新增 `codeActProgress` store + `handleCodeActProgress()` + `clearCodeActProgress()` |
| `src/dashboard/ui/src/lib/ws.js` | 路由 `codeact:progress` 事件到 store |
| `src/dashboard/ui/src/panels/CodeActPanel.svelte` | 重写：侧栏 `<button>` + `getGroupLabel` + chatTitle + badge + hover/active 动画；实时进度流式渲染（thinking/code/output 分区 + fade-in 动画）；自动滚动跟踪 |

## 2026-03-21: 沙箱交互式 Shell（node-pty）

将 sandbox 的 shell 执行从一次性 `child_process.exec()` 替换为 **node-pty 持久化交互式 PTY**，解决状态无法保持、cwd 不确定、无法交互的问题。

### 核心变更

- **执行方式**：shell 命令不再经过 worker 进程（IPC），改由 host 侧（`sandbox.ts`）直接管理的 PTY bash 进程执行
- **Per-chat Home 目录**：每个 Sandbox 实例（每个 chatId）拥有独立的 workspace 目录 `workspace/<chatId>/`，PTY 的 `$HOME` 和初始 cwd 均设为此路径
- **状态持久化**：`cd`、环境变量、alias 等在同一 Sandbox 实例生命周期内保持
- **cwd 追踪**：每次命令输出末尾附加 `[cwd: /当前路径]`

### Sentinel 机制

命令写入 PTY 后追加 `echo '__SANDBOX_DONE_<id>'_$?_$(pwd)__`，匹配 sentinel 时提取输出、退出码和当前 cwd。此模式与 VS Code Shell Integration 类似。

### 改动

| 文件 | 改动 |
|------|------|
| `src/sandbox/sandbox.ts` | 新增 `startPty()`、`handlePtyData()`；重写 `executeShell()` 为 PTY 模式；构造函数接受 `chatId` |
| `src/sandbox/sandbox-pool.ts` | `new Sandbox()` 传入 `chatId` |
| `src/sandbox/sandbox-worker.ts` | 移除 `executeShell`、`ExecuteShellMessage`、`execute_shell` 处理 |
| `system-prompts/subagent-execution.md` | bash 章节更新为交互式 Shell 说明 |
| `package.json` | 新增 `node-pty` 依赖 + `postinstall` 修复 spawn-helper 权限 |

## 2026-03-21: 修复 Q3 Block 机制失效 — CodeAct 执行期间同群重复 Attend

### Bug

CodeAct session 正在执行时（session-runner 运行中），同一群组仍被 attend-handler 调用 LLM 做决策。日志表现为两者并发运行：

```
12:45:06 attend-handler gemini-3-flash-preview 4591ms (28257tok)
12:45:04 session-runner kimi-k2.5 ±100 还在运行
```

**根因**：`q3.block()` 是一个空操作。`dequeue()` 在 Phase 3 将 entry 从 Map 中 `delete`，随后 Phase 6 的 `block(chatId)` 调用 `entries.get(chatId)` 返回 `undefined`，`if (entry)` 为 false，静默跳过。后续新消息通过 triage-engage 或 DIRECT_ADDRESS 触发 `enqueueOrUpdate()`，创建全新的 `blocked: false` 条目，下一个 tick 即被出队 attend。

### 方案

在 `DynamicAttentionQueue` 中引入独立于 entry 生命周期的 `blockedChatIds: Set<string>`：

- `block()` → 写入 Set + 标记 entry（如存在）
- `unblock()` → 从 Set 移除 + 清理 entry（如存在）
- `enqueueOrUpdate()` → 检查 Set，blocked 的 chatId **直接丢弃，不入队**

丢弃而非保留的理由：正在执行的 sandbox 已通过消息上送机制（`pushPendingMessage`）在 turn 间收到最新消息，不需要也不应该再进行 attend 决策。CodeAct 结束后 unblock，正常管线（triage-engage / DIRECT_ADDRESS）自然恢复入队。

### 改动

| 文件 | 改动 |
|------|------|
| `src/subagent/attention-queue.ts` | 新增 `blockedChatIds: Set<string>`；`block()`/`unblock()` 操作 Set 不再依赖 entry 存在；`enqueueOrUpdate()` 开头检查 Set 并静默拒绝；新增 `isBlocked()` 方法；`clear()` 同步清理 Set |

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
