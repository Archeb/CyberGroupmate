# CyberGroupmate 核心架构 (V3)

> **文档状态**: 当前实现的忠实映射
> **创建日期**: 2026-04-22
> **目标读者**: 需要快速理解代码库并贡献代码的 Coding Agent
> **相较 V2 的变化**: 删除了 FastPathHandler 和 MiniCodeAct；新增 Grounding、AgentSkills 渐进式披露、Multi-Tab Shell、Vision 沙盒模块、MCP Bridge、Cron/KV/Events/HTTP 模块、System Prompts Override、Prometheus Metrics。

---

## 1. 核心设计哲学

CyberGroupmate 是一个接入即时通讯平台（Telegram / Discord / OneBot）的 AI 群友 Agent。

**速度分层**：主 Agent 是快速决策者，CodeActExecutor 是慢速执行者。两者通过队列解耦，互不阻塞。

**双层架构**：
- **Main Agent**（单线程决策层）：拥有全局视野，串行轮询注意力队列，决定对哪个群做什么。自身不执行任何沙盒操作。
- **GroupSubagent**（per-group 执行与感知层）：每个群一个实例，负责消息感知（Observer）、话题聚类（RecordingPipeline）和代码执行（CodeActExecutor）。

---

## 2. 系统分层

```
┌─────────────────────────────────────────────────────┐
│  平台适配层  TelegramAdapter / DiscordAdapter / OneBotAdapter  │
│                src/adapter/                          │
└───────────────────────┬─────────────────────────────┘
                        │ 标准化事件
┌───────────────────────▼─────────────────────────────┐
│  全局事件总线  NotificationCenter (Q1)                │
│                src/event/notification-center.ts      │
│  + MessageLogWriter → SQLite message_log             │
└──────────┬─────────────────────────┬────────────────┘
           │ onPush Hook              │ onPush Hook
┌──────────▼──────────┐   ┌──────────▼──────────────┐
│  per-group Observer │   │  FeedbackLoop            │
│  + RecordingPipeline│   │  src/pipeline/index.ts   │
│  src/subagent/      │   └─────────────┬────────────┘
│  src/pipeline/      │                 │ 追问检测→Q3
└──────────┬──────────┘                 │
           │ triage-engage / alert       │
┌──────────▼─────────────────────────────────────────┐
│  注意力队列 DynamicAttentionQueue (Q3)              │
│                src/subagent/attention-queue.ts      │
└───────────────────────┬─────────────────────────────┘
                        │ dequeue
┌───────────────────────▼─────────────────────────────┐
│  Main Agent Loop (7 Phase 循环)                      │
│  src/main-agent/main-agent-loop.ts                  │
│  attend-handler.ts (Phase 4-5) → LLM 决策           │
│  dispatch-handler.ts (Phase 6) → 任务分派            │
└──────────┬──────────────────────────────────────────┘
           │ REPLY → CodeActReplyTask → Q4
┌──────────▼──────────────────────────────────────────┐
│  per-group CodeActExecutor (Q4)                     │
│  src/subagent/code-act-executor.ts                  │
│  → session-runner.ts → SandboxPool → Sandbox Worker │
└──────────┬──────────────────────────────────────────┘
           │ SubagentCallback → Q5
┌──────────▼──────────────────────────────────────────┐
│  CallbackQueue (Q5) → Phase 1 回收                  │
│  src/subagent/callback-queue.ts                     │
└─────────────────────────────────────────────────────┘
```

---

## 3. 关键组件与文件映射

### 3.1 入口与启动

| 组件 | 文件 | 说明 |
|:-----|:-----|:-----|
| 主入口 | `src/main.ts` | 初始化所有组件、注册 Host Call 路由、启动平台适配器和主循环 |
| 配置加载 | `src/core/config.ts` | YAML 配置的加载/验证/保存，`AppConfig` 类型定义 |

### 3.2 平台适配层

| 组件 | 文件 | 说明 |
|:-----|:-----|:-----|
| TelegramAdapter | `src/adapter/telegram-adapter.ts` | Telegram MTProto（用户账号）或 Bot API 接入 |
| DiscordAdapter | `src/adapter/discord-adapter.ts` | Discord Bot 接入 |
| OneBotAdapter | `src/adapter/onebot-adapter.ts` | OneBot v11 协议（QQ 等）接入 |
| 平台适配器接口 | `src/adapter/platform-adapter.ts` | 所有适配器的统一接口定义 |

适配器职责：接收平台原始事件 → 标准化为 `NotificationEvent` → push 到 NC。适配器同时暴露 `handleCall(method, args)` 接收来自沙盒的平台写操作（sendText、sendSticker 等）。

### 3.3 事件总线

| 组件 | 文件 | 说明 |
|:-----|:-----|:-----|
| NotificationCenter | `src/event/notification-center.ts` | 系统心脏；同步分发事件到所有 `onPush` 钩子；支持 JSONL 落盘和 `fs.watch` 注入 |
| MessageLogWriter | `src/event/message-log-writer.ts` | NC 钩子，将消息实时写入 SQLite `message_log` 表 |

### 3.4 感知层 (per-group)

| 组件 | 文件 | 说明 |
|:-----|:-----|:-----|
| GroupSubagent | `src/subagent/group-subagent.ts` | 群组级容器，持有 Observer + TopicRegistry + RecordingPipeline + CodeActExecutor |
| SubagentManager | `src/subagent/subagent-manager.ts` | 管理所有群组的 GroupSubagent 实例（懒创建） |
| Observer | `src/subagent/observer.ts` | 消息缓冲（Q2）、Engagement 计算（纯算法）、告警检测 |
| TopicRegistry | `src/pipeline/topic-registry.ts` | per-group 话题状态机（ACTIVE→ENGAGED→COOLDOWN→ARCHIVED 等） |
| RecordingPipeline | `src/pipeline/recording-pipeline.ts` | 后台话题聚类 + LLM Triage；触发 `triage-engage` 事件将群推入 Q3 |
| FeedbackLoop | `src/pipeline/index.ts` | 追踪 Agent 发言后的用户反响；追问检测（90s 窗口）→ Q3 boost |
| Stickiness | `src/subagent/stickiness.ts` | 群组亲密度四级制（CORE/FAMILIAR/ACQUAINTANCE/STRANGER），影响优先级乘数、深度周期等 |

**数据流细节**：
- 消息到达 → Observer 缓冲(Q2) + RecordingPipeline.onMessage()
- RecordingPipeline flush → LLM 聚类 → Triage → `topics:triage-passed` 事件 → 更新 Observer 的 `topicDigests` + 发出 `triage-engage` 推入 Q3
- Observer Engagement > 阈值 → 直接告警入队 Q3（紧急路径）
- DM 或 @mention → 立即入队 Q3（必须响应路径）

### 3.5 主 Agent 决策层

| 组件 | 文件 | 说明 |
|:-----|:-----|:-----|
| MainAgentLoop | `src/main-agent/main-agent-loop.ts` | 7 Phase 串行注意力循环，持有 LLM 对话历史和 Circuit Breaker |
| AttendHandler | `src/main-agent/attend-handler.ts` | Phase 4-5：按 Cosine Decay 深度构建上下文 + 调用主 LLM 决策 |
| DispatchHandler | `src/main-agent/dispatch-handler.ts` | Phase 6：将决策转化为 CodeActReplyTask 分派给 CodeActExecutor |
| ContextBuilder | `src/main-agent/context-builder.ts` | 组装 `GroupContextPackage`（消息、画像、话题、回调等） |
| CosineDecay | `src/main-agent/cosine-decay.ts` | 根据 attendCount 和 depthCyclePeriod 计算 L0~L3 上下文深度 |
| PromptRenderer | `src/main-agent/prompt-renderer.ts` | Mustache 模板渲染；管理所有 system prompt 模板缓存 |
| GlobalState | `src/main-agent/global-state.ts` | 任务列表、最近决策、调度事件的 JSON 持久化 |
| GroundingUtil | `src/main-agent/grounding-util.ts` | 并行调用 Google Grounding / Grok Web Search 进行事实查证 |

**主 Agent 7 Phase 循环**：
1. **Phase 1** — drain Q5 Callbacks，更新 GlobalState 和对话历史
2. **Phase 2** — 动态评估 Q3（时间衰减 + 告警提权 + hasTriageEngaged 守卫）
3. **Phase 3** — dequeue 最高优先级群组（最多 `maxAttendsPerTick` 个）
4. **Phase 4** — `attend-handler`：计算 Cosine Decay 深度 → 组装上下文 → 并行 Grounding
5. **Phase 5** — `attend-handler`：调用主 LLM，解析 JSON 决策（REPLY / DEFER / OBSERVE）
6. **Phase 6** — `dispatch-handler`：REPLY → 构建 CodeActReplyTask + 入队 Q4；DEFER → 重排 Q3
7. **Phase 7** — 持久化 GlobalState，更新 Q3 block/unblock 状态

**上下文深度 (L0~L3)**：由 `cosine-decay.ts` 基于余弦函数计算。Alert 信号强制最低 L2。`topicDigests` 和 `groupModel` 均为空时自动升级至 L2。每级消息量：L0=10条，L1=30条，L2=50条，L3=100条。

**主 Agent 决策动作**：
- `REPLY` → 分派 `CodeActReplyTask` 给 CodeActExecutor
- `DEFER` → 半优先级重排回 Q3，等候下次 attend
- `OBSERVE` → 静默记录，不产生任何动作

> ⚠️ **FastPathHandler 已移除**：V2 中的 `FAST_PATH_AUTH` 决策动作和 `FastPathHandler` 组件在当前代码库中**不存在**。不要尝试添加或恢复此功能。

### 3.6 执行层

| 组件 | 文件 | 说明 |
|:-----|:-----|:-----|
| CodeActExecutor | `src/subagent/code-act-executor.ts` | per-group 串行执行器；Q4 任务队列；持有 LLM Session（对话历史）+ ContextManager 两层 compact |
| SessionRunner | `src/sandbox/session-runner.ts` | 单次 CodeAct Session 运行器；Two-pass 代码生成（Pass1 轻量概览 → 按需 Pass2 完整文档注入）；循环：LLM 思考 → 执行代码 → Observation → 重复直到完成 |
| SandboxPool | `src/sandbox/sandbox-pool.ts` | 全局 Sandbox 实例池，管理并发数（默认 5）和空闲回收 |
| Sandbox | `src/sandbox/sandbox.ts` | Host 侧沙盒管理器；子进程生命周期、Multi-Tab PTY（`shell.*`）、Host Call 路由、事件监听器和 Webhook 持久化 |
| SandboxWorker | `src/sandbox/sandbox-worker.ts` | Worker 子进程；执行 LLM 生成的 JS/TS 代码；暴露所有沙盒 API 全局变量 |

**沙盒代码块类型**：
- `javascript/typescript` → 在 Worker VM 中执行，可调用所有沙盒 API
- `bash/shell` → 通过 Multi-Tab PTY 执行 CLI 命令，`cwd` 为 `workspace/`

**Multi-Tab Shell**（`src/sandbox/modules/shell/`）：
- `shell.listTabs()` — 列出所有终端 Tab
- `shell.detach(name)` — 将当前 default tab 推入后台并改名
- `shell.read(tabId?)` — 读取指定 tab 的最近 500 行滚动缓冲
- `shell.sendInput(input, tabId?)` — 向终端注入键盘输入
- `shell.kill(tabId?)` — 强制关闭终端 Tab
- `shell.cwd()` — 获取当前工作目录

### 3.7 沙盒 API 模块

所有模块在 `sandbox-worker.ts` 中注入为全局变量。平台 API 以顶层变量形式注入（`telegram`、`discord`、`onebot`），不再通过 `ctx.tg`。

| 模块 | 全局变量 | 文件 | 说明 |
|:-----|:---------|:-----|:-----|
| 平台 API | `telegram` / `discord` / `onebot` | `src/sandbox/modules/telegram/` 等 | 消息发送、媒体下载、贴纸等 |
| 记忆 | `memory` | `src/sandbox/modules/memory/` | recall、browseHistory、reflect |
| 文件系统 | `fs` | `src/sandbox/modules/filesystem/` | 读写 workspace/ 内文件 |
| Runtime | `runtime` | `src/sandbox/modules/runtime/` | notify、print、input、remind |
| Shell | `shell` | `src/sandbox/modules/shell/` | Multi-Tab PTY 管理 |
| Vision | `vision` | `src/sandbox/modules/vision/` | `vision.see(path...)` 图片理解 |
| KV Store | `kv` | `src/sandbox/modules/kv/` | SQLite 键值存储，per-chat 隔离 |
| Events | `events` | `src/sandbox/modules/events/` | NC 事件监听器（持久化） |
| Cron | `cron` | `src/sandbox/modules/cron/` | 持久化定时任务（最短 1 小时间隔） |
| HTTP Webhook | `http` | `src/sandbox/modules/http/` | 注册/移除 HTTP Webhook |
| MCP Bridge | `mcpBridge` | `src/sandbox/modules/mcp-bridge/` | stdio + Streamable HTTP MCP 客户端 |
| Docs | `docs` | `src/sandbox/modules/docs/` | 读取 workspace/agent-docs/ 中的 markdown 文档 |
| Actions | `actions` | `src/sandbox/modules/actions/` | getTopicContext、listActiveTopics、recallForTopic |

**AgentSkills 渐进式披露**：
- `baseSkills`（`config.yaml`）：始终注入 executor 的常驻模块（如 `memory`、`fs`、`runtime`）
- 主 Agent 在 attend 决策时输出 `useSkills: ["skill_name"]` 指定本次任务需要的扩展模块
- CodeActExecutor 仅将 `baseSkills + platform + useSkills` 对应模块的文档注入 System Prompt
- AgentSkills（TS Skills）以 `.use()` 形式调用，存放于 `workspace/skills/`

**Host Call 安全**：沙盒内向平台发送消息时，`main.ts` 中的 Host Call 路由检查 `targetChatId === chatId`，禁止跨群发送。

### 3.8 记忆系统 V2

所有代码位于 `src/memory-v2/`。

| 组件 | 文件 | 说明 |
|:-----|:-----|:-----|
| MemoryStoreV2 | `memory-v2.ts` | 主入口；封装所有 SQLite 操作 |
| Reflection | `reflection.ts` | 定时/冷场触发的 LLM 反思，更新画像和核心事实 |
| ContextManager | `context-manager.ts` | 对话历史 token 预算管理；两层 compact（结构化截断 + LLM 压缩） |
| Embedding | `embedding.ts` | 向量嵌入（sqlite-vec 或纯 JS cosine fallback） |
| MessageSnapshot | `message-snapshot.ts` | 消息快照工具 |

**SQLite 数据表**：
- `message_log` — 原始消息（底层事实来源）
- `topics` + `topics_fts` — 话题节点（中期记忆）
- `person_group_profiles` — 人物在群内的画像（含 dunbar_tier）
- `person_identities` — 跨群身份信息
- `group_models` — 群组画像
- `core_facts` + `core_facts_fts` — 核心事实（长期记忆）
- `sticker_descriptions` — 贴纸视觉描述缓存
- `kv_store` — 沙盒 KV 存储

### 3.9 视觉与媒体

| 组件 | 文件 | 说明 |
|:-----|:-----|:-----|
| MessageEnricher | `src/core/message-enricher.ts` | 解析 `mediaInfo` → `MediaAttachment[]`；驱动 Vision 处理管线 |
| VisionProcessor | `src/core/vision-processor.ts` | 图片三路径处理（原生多模态/Vision LLM 描述/占位文本）；贴纸三模式 |
| MediaDownloader | `src/core/media-downloader.ts` | 将媒体文件保存到 `workspace/Downloads/`，按 `uniqueFileId` 去重，自动清理 |

**调用时机**：主 Agent attend 阶段只用 `formatMessageLine` 生成纯文本媒体标签（`[📷 图片]`）；CodeAct 执行阶段才调用完整 `enrichMessages()` 做 Vision 处理和媒体下载。

### 3.10 Dashboard 与可观测性

| 组件 | 文件 | 说明 |
|:-----|:-----|:-----|
| DashboardServer | `src/dashboard/dashboard-server.ts` | Express HTTP 服务；token 鉴权中间件 |
| ApiRoutes | `src/dashboard/api-routes.ts` | REST API：消息/话题/记忆/配置/贴纸/System Prompts 等 |
| EventBridge | `src/dashboard/event-bridge.ts` | NC 事件转 SSE 推送给前端 |
| Metrics | `src/metrics/` | Prometheus 格式指标；默认绑定 `127.0.0.1:9091` |

**System Prompts Override**（`src/core/prompt-loader.ts`）：Dashboard 可编辑 system prompt；override 保存到 `workspace/system-prompts-overrides/`，优先于 `system-prompts/` 目录中的原始文件。保存后自动清除所有模块的 prompt 缓存。

---

## 4. 数据流：Q1~Q5 队列梳理

| 队列 | 类型 | 产出方 | 消费方 | 说明 |
|:-----|:-----|:-------|:-------|:-----|
| **Q1** | NotificationCenter | 平台适配器 | MessageLogWriter, GroupSubagent.onMessage(), FeedbackLoop | 事件总线，同步分发 |
| **Q2** | Observer 内部 buffer | Observer.onMessage() | attend 时 clearBuffer() | 消息缓冲区，参与 Engagement 计算 |
| **Q3** | DynamicAttentionQueue | Observer(alert), RecordingPipeline(triage-engage), FeedbackLoop(追问), 主 Agent(DEFER), 调度器(SCHEDULER_TRIGGER) | MainAgentLoop Phase 3 dequeue | 支持时间衰减、block/unblock、priority boost |
| **Q4** | CodeActExecutor 内部 task queue | DispatchHandler(REPLY 决策) | CodeActExecutor 串行消费 | per-group 串行，防止同一群并发执行 |
| **Q5** | CallbackQueue | CodeActExecutor(完成/失败) | MainAgentLoop Phase 1 drain | Subagent 向主 Agent 的回执箱 |

---

## 5. 关键约定与注意事项

**不要破坏的约定**：
1. 主 Agent 循环是**串行**的——不能在 Phase 4-5 中做任何异步阻塞操作（Grounding 已用 Promise.allSettled 并行化）
2. **沙盒安全边界**：代码只能向自己绑定的 `chatId` 发送消息，main.ts 中有跨群发送拦截守卫
3. **Memory 写操作应在 per-group 上下文中**，避免跨群 ID 混用
4. 话题 ID（`topicId`）格式为 ULID；chatId 格式为 `platform:rawId`（如 `telegram:123456`）
5. `message_log` 是唯一的消息事实来源，不要绕过它直接操作平台 API 获取历史

**已删除的功能（不要尝试恢复）**：
- `FastPathHandler` / `FAST_PATH_AUTH` 决策 — V2 的快速通道，已从代码库完全删除
- `MiniCodeAct` / `minicodeact-handlers/` — V2 的主 Agent 内置工具调用层，已从代码库完全删除。相关文档在 `docs/deprecated/`

**Prompt 模板位置**：
- `system-prompts/main-agent/` — 主 Agent 系统提示（mainagent-main-system.md、mainagent-attention.md 等）
- `system-prompts/executor/` — CodeAct 执行器提示
- `system-prompts/memory/` — Reflection/ContextManager 提示
- `system-prompts/recording/` — RecordingPipeline 话题聚类/Triage 提示
- override 路径：`workspace/system-prompts-overrides/`（同目录结构，优先级更高）

---

## 6. 端到端数据链路（简化）

```
用户在 Telegram 群发消息
    ↓
TelegramAdapter → NC.push(event)
    ↓ [同步]
MessageLogWriter → SQLite message_log
GroupSubagent.onMessage(event)
    ├─ Observer: 缓冲(Q2) + Engagement 计算
    └─ RecordingPipeline: 消息缓冲 → [50条或2min静默] → flush
         └─ LLM 话题聚类 → Triage
              └─ triage-engage → Q3.enqueue(chatId)
    ↓
FeedbackLoop: 检测是否为 Agent 发言后追问 → Q3.boost(chatId)
    ↓
MainAgentLoop tick (每 5s 一轮):
  Phase 1: drain Q5 callbacks → GlobalState + 对话历史
  Phase 2: Q3 时间衰减评估
  Phase 3: dequeue 最高优先级群组
  Phase 4: Cosine Decay 深度 → buildGroupContext → 并行 Grounding
  Phase 5: callLLM → 解析 JSON 决策
  Phase 6: 决策=REPLY → CodeActReplyTask → Q4
  Phase 7: Q3 block(chatId) + GlobalState 持久化
    ↓
CodeActExecutor.enqueue(task):
  acquire sandbox from SandboxPool
  enrichMessages() → Vision 处理 + 媒体下载
  runCodeActSession():
    Loop: LLM 思考 + 代码 → sandbox.execute() → observation → 重复
    代码内调用 telegram.sendText() → Host Call → TelegramAdapter
  release sandbox
  → Q5.push(SubagentCallback)
    ↓
下一 tick Phase 1: 主 Agent 收到 callback，Q3 unblock(chatId)
```

---

## 7. 文件目录速查

```
src/
  main.ts                    # 系统入口，组装所有组件
  adapter/                   # 平台适配器
  core/                      # 共享基础工具（config, llm, logger, timezone, vision-processor等）
  event/                     # NotificationCenter + MessageLogWriter
  main-agent/                # 主 Agent 决策层（loop + attend + dispatch + grounding）
  subagent/                  # GroupSubagent + Observer + CodeActExecutor + 队列
  pipeline/                  # RecordingPipeline + TopicRegistry + FeedbackLoop
  sandbox/                   # Sandbox host + worker + session-runner + modules
  memory-v2/                 # 记忆系统（SQLite + Reflection + ContextManager）
  dashboard/                 # Express API + SSE + Dashboard UI
  metrics/                   # Prometheus 指标导出
system-prompts/              # 所有 LLM prompt 模板
workspace/                   # 运行时数据目录（sessions, downloads, skills, global-state等）
```
