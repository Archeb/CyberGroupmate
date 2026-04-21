# Dashboard 实时监控仪表盘

嵌入式 Web 监控面板，运行时可视化系统全状态并支持有限度的实时干预。

## 快速开始

### 配置

在 `config.yaml` 中添加：

```yaml
dashboard:
  port: 6767          # HTTP 端口（默认 6767）
  token: "your-token" # 认证 Token（默认 "cybergroupmate"）
  enabled: true       # 是否启用（默认 true）
```

### 访问

启动项目后浏览器访问：

```
http://localhost:6767?token=your-token
```

WebSocket 实时推送也使用同一 Token 认证。

---

## 功能面板

### 💬 消息流

实时显示所有 NC 推送的消息，按群组分类。

- 左侧群组列表（显示群组标题而非 ID），点击过滤特定群的消息
- 选中群组时自动从 Memory 加载最近 100 条历史消息，与实时消息合并去重
- 消息流实时更新（WebSocket 推送，无需刷新）
- Agent 自身发言高亮显示
- @mention 消息左侧标记
- 「全部」视图下每条消息显示来源群组标签（固定宽度对齐）
- 消息项各元素（时间戳、用户名）带有低对比度背景色，便于视觉区分
- 点击用户名可跳转到记忆查询面板查看该用户画像
- 自动滚动到最新消息（用户手动滚动时暂停自动滚动）

### 📋 话题注册表 (TopicRegistry)

按群组展开查看当前所有话题的状态。

- 每个群组折叠展示（显示群组标题），展开时自动加载话题
- 展开/折叠状态在自动刷新后保持不丢失
- 合并显示 pipeline 内存中的实时话题和 SQLite 中最近 7 天的历史话题
- 历史话题标记「历史」标签，已回应话题显示「已回应 ×N」
- 显示话题标签、摘要、状态（ACTIVE / STALE / ARCHIVED）
- 参与者列表（可点击查询画像）
- 关键词、消息数量等元数据
- 点击话题卡片可跳转到「📖 话题详情」面板查看详细信息和相关聊天记录

### 📖 话题详情

查看单个话题的完整信息和关联聊天记录。

- 从话题注册表或记忆搜索结果中点击话题卡片进入
- 显示话题元数据：标题、摘要、状态、时间范围、情感、关键词
- 参与者列表（可点击查询画像）、要点列表
- 已回应状态和回应次数
- 相关聊天记录列表（从 `message_log` 中按 `message_ids` 精确查询）

### ⚡ 注意力队列 (Q3)

实时查看主 Agent 动态注意力队列的排序状态。

- 按优先级排序显示所有条目
- 显示来源（OBSERVER_ALERT / DIGEST_UPDATE）
- Stickiness 亲密度等级、新消息数、话题数
- 阻塞状态标记
- 已出队历史记录（折叠显示最近 50 条）
- **干预操作**：
  - ⬆ 优先级 Boost（+20）
  - ✕ 移除条目
  - 手动入队（指定 chatId + 优先级）

### 🧠 决策日志

查看主 Agent 的决策历史和 LLM 对话上下文。

- 左侧：`GlobalState.recentDecisions` 列表（时间戳 + chatId + 决策内容）
- 右侧：主 Agent LLM 对话历史（`MainAgentLoop.conversationHistory`），按 role 着色
  - system = 蓝色
  - user = 绿色
  - assistant = 紫色

### 🔧 CodeAct 沙箱

按群组查看 CodeActExecutor 的执行状态和 session 对话历史。

- 左侧群组列表（显示群组标题），标记正在执行的群组（🔄）
- Session 统计：session 消息数、执行次数、任务队列大小
- Session 对话历史：按 role 分段展示，不同角色使用显著区分的背景色
  - system = 深蓝背景 + 蓝色左边框
  - user = 深黄背景 + 黄色左边框
  - assistant = 深粉背景 + 粉色左边框
- 代码块语法高亮（highlight.js）
- **实时流式更新**：当 CodeAct 正在执行时，每 2 秒自动刷新 session 内容，无需手动操作；执行完成后自动停止轮询
- **干预操作**：取消执行（销毁 sandbox + 解除 Q3 阻塞）

### 🧬 记忆查询

交互式查询 Memory V2 中的用户、群组数据，以及语义搜索。

- **用户查询**：输入 userId（+ 可选 chatId），返回：
  - `PersonIdentity`（全局身份信息）
  - `PersonGroupProfile`（群内画像：Dunbar tier、traits、interests、communication style）
  - `recall()` 召回结果（相关 facts/topics）
- **群组查询**：输入 chatId，返回：
  - `GroupModel`（群模型：交互风格、最近反馈、engagement level）
  - 群内所有用户的 `PersonGroupProfile` 列表
- **🔍 记忆搜索 (Recall)**：关键词/语义检索
  - 支持 FTS5 全文搜索 + 向量语义搜索（双路径）
  - 可选限定群组 (chatId)
  - 结果分三类展示：话题（可点击进入详情）、事实（含置信度百分比）、关联人物
  - 超过 token 阈值时自动生成 deep summary

消息流和话题面板中的用户名/群名可点击直接跳转到此面板查询。

### ⚙️ 系统状态

全局系统组件的运行状态汇总。

- **全局状态 (GlobalState)**：任务列表、待处理 follow-up、注意力摘要（JSON 高亮展示）
- **SandboxPool 状态**：总实例数 / 使用中 / 空闲，每个实例的 chatId 和状态
- **追问检测窗口 (FeedbackLoop)**：当前哪些群处于追问检测窗口、剩余时间
- **群组概览表**：所有群的 Stickiness 等级、Engagement 分数、Observer 缓冲区大小、attend 次数
- **最近 Callbacks (Q5)**：Subagent 执行回调结果（状态、类型、摘要、耗时）

---

## 前端特性

### 自动明亮/黑暗模式

跟随系统 `prefers-color-scheme` 自动切换 daisyUI 主题（dark/light），CodeAct 角色样式同步适配。

### 自动滚动

所有可滚动面板（消息流、CodeAct session、决策日志等）支持自动滚动到底部。当用户手动上滚查看历史时，暂停自动滚动，避免干扰。

### 自动刷新

- 5 秒周期刷新 overview snapshot
- 当前活跃 tab 自动刷新数据，无需手动切换 tab
- CodeAct 执行中时 2 秒快速轮询

### JSON / 代码高亮

使用 highlight.js CDN 对 JSON 数据和 CodeAct 中的代码块进行语法高亮。

### 交互式元素

- 可点击的用户名 / chatId：外观为下划线链接样式（`.clickable-link`）
- 表格中的 ID：虚线下划线样式（`.clickable-id`）

---

## 技术架构

### 后端

- **Express HTTP Server** — REST API + 静态文件服务
- **WebSocket Server (ws)** — 实时事件推送
- **Token 认证** — API 通过 query param `?token=` 或 `Authorization: Bearer` header 认证；WebSocket 通过 upgrade URL 的 query param 认证

### 前端

- 纯 HTML + JavaScript SPA（无 React/Vue）
- **daisyUI v5**（Tailwind CSS 组件库）自动明亮/暗色主题
- **highlight.js**（JSON + JavaScript + Python 语法高亮）
- WebSocket 客户端自动重连（3 秒间隔）
- 5 秒周期性刷新 overview snapshot

### 事件桥接 (EventBridge)

- Hook NC `onPush` 事件，将消息实时广播给所有 WebSocket 客户端
- 新连接时发送完整系统快照 + 最近 200 条事件回放
- 快照中包含群组标题（`chatTitle`）和出队历史
- Q3 变更时主动广播队列更新

### REST API 端点

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/overview` | 全系统快照 |
| GET | `/api/messages/:chatId` | 群组最近消息（支持 `?limit=` 参数） |
| GET | `/api/topics/:chatId` | 群组话题列表（合并 pipeline + 历史 7 天） |
| GET | `/api/topics` | 所有群组话题 |
| GET | `/api/topic/:topicId` | 单个话题详情 + 关联消息 |
| GET | `/api/queue` | Q3 队列（含出队历史） |
| POST | `/api/queue/enqueue` | 手动入队 |
| POST | `/api/queue/boost` | 优先级提升 |
| DELETE | `/api/queue/:chatId` | 移除条目 |
| GET | `/api/decisions` | 最近决策 |
| GET | `/api/global-state` | 全局状态 |
| GET | `/api/memory/user/:userId` | 用户画像 |
| GET | `/api/memory/group/:chatId` | 群组画像 |
| POST | `/api/memory/recall` | 记忆搜索（关键词/语义） |
| GET | `/api/codeact/:chatId` | CodeAct session |
| POST | `/api/codeact/:chatId/cancel` | 取消执行 |
| GET | `/api/sandbox/pool` | SandboxPool 状态 |
| GET | `/api/feedbackloop` | 追问窗口 |
| GET | `/api/main-agent/history` | 主 Agent 对话历史 |
| GET | `/api/callbacks` | Q5 回调队列 |

---

## 文件结构

```
src/dashboard/
├── dashboard-server.ts   # Express + WebSocket 服务器
├── api-routes.ts         # REST API 路由
├── event-bridge.ts       # NC 事件 → WebSocket 桥接
├── types.ts              # 类型定义
└── public/
    ├── index.html         # SPA 入口
    ├── app.js             # 前端应用逻辑
    └── style.css          # 自定义样式
```
