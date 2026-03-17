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

- 左侧群组列表，点击过滤特定群的消息
- 消息流实时更新（WebSocket 推送，无需刷新）
- Agent 自身发言高亮显示
- @mention 消息左侧标记
- 点击用户名可跳转到记忆查询面板查看该用户画像

### 📋 话题注册表 (TopicRegistry)

按群组展开查看当前所有话题的状态。

- 每个群组折叠展示，点击加载话题列表
- 显示话题标签、摘要、状态（ACTIVE / STALE / ARCHIVED）
- 参与者列表（可点击查询画像）
- 关键词、消息数量等元数据

### ⚡ 注意力队列 (Q3)

实时查看主 Agent 动态注意力队列的排序状态。

- 按优先级排序显示所有条目
- 显示来源（OBSERVER_ALERT / FAST_PATH_REQUEST / DIGEST_UPDATE）
- Stickiness 亲密度等级、新消息数、话题数
- 阻塞状态标记
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

- 左侧群组列表，标记正在执行的群组（🔄）
- Session 统计：session 消息数、执行次数、任务队列大小
- Session 对话历史：按 role 分段展示每一轮 LLM 交互（system/user/assistant）
- **干预操作**：取消执行（销毁 sandbox + 解除 Q3 阻塞）

### 🧬 记忆查询

交互式查询 Memory V2 中的用户和群组数据。

- **用户查询**：输入 userId（+ 可选 chatId），返回：
  - `PersonIdentity`（全局身份信息）
  - `PersonGroupProfile`（群内画像：Dunbar tier、traits、interests、communication style）
  - `recall()` 召回结果（相关 facts/topics）
- **群组查询**：输入 chatId，返回：
  - `GroupModel`（群模型：交互风格、最近反馈、engagement level）
  - 群内所有用户的 `PersonGroupProfile` 列表

消息流和话题面板中的用户名/群名可点击直接跳转到此面板查询。

### ⚙️ 系统状态

全局系统组件的运行状态汇总。

- **全局状态 (GlobalState)**：任务列表、待处理 follow-up、注意力摘要（JSON 展示）
- **SandboxPool 状态**：总实例数 / 使用中 / 空闲，每个实例的 chatId 和状态
- **追问检测窗口 (FeedbackLoop)**：当前哪些群处于追问检测窗口、剩余时间
- **群组概览表**：所有群的 Stickiness 等级、Engagement 分数、Observer 缓冲区大小、attend 次数、FastPath 授权状态
- **最近 Callbacks (Q5)**：Subagent 执行回调结果（状态、类型、摘要、耗时）

---

## 技术架构

### 后端

- **Express HTTP Server** — REST API + 静态文件服务
- **WebSocket Server (ws)** — 实时事件推送
- **Token 认证** — API 通过 query param `?token=` 或 `Authorization: Bearer` header 认证；WebSocket 通过 upgrade URL 的 query param 认证

### 前端

- 纯 HTML + JavaScript SPA（无 React/Vue）
- **daisyUI v5**（Tailwind CSS 组件库）暗色主题
- WebSocket 客户端自动重连（3 秒间隔）
- 10 秒周期性刷新 overview snapshot

### 事件桥接 (EventBridge)

- Hook NC `onPush` 事件，将消息实时广播给所有 WebSocket 客户端
- 新连接时发送完整系统快照 + 最近 200 条事件回放
- Q3 变更时主动广播队列更新

### REST API 端点

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/overview` | 全系统快照 |
| GET | `/api/messages/:chatId` | 群组最近消息 |
| GET | `/api/topics/:chatId` | 群组话题列表 |
| GET | `/api/topics` | 所有群组话题 |
| GET | `/api/queue` | Q3 队列 |
| POST | `/api/queue/enqueue` | 手动入队 |
| POST | `/api/queue/boost` | 优先级提升 |
| DELETE | `/api/queue/:chatId` | 移除条目 |
| GET | `/api/decisions` | 最近决策 |
| GET | `/api/global-state` | 全局状态 |
| GET | `/api/memory/user/:userId` | 用户画像 |
| GET | `/api/memory/group/:chatId` | 群组画像 |
| GET | `/api/codeact/:chatId` | CodeAct session |
| POST | `/api/codeact/:chatId/cancel` | 取消执行 |
| GET | `/api/sandbox/pool` | SandboxPool 状态 |
| POST | `/api/fastpath/:chatId/revoke` | 撤销 FastPath |
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
