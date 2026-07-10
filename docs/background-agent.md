# RFC: Background Agent（做梦系统）

> **Status:** Draft
>
> **Author:** Mozukito, Miu
>
> **Last updated:** 2026-05-29

---

## 概述

引入 Background Agent 作为与 Meta Agent 平级的第三类 agent。它不参与实时聊天，而是在后台执行需要完整开发环境和长时间运行的任务——自进化、深度跟进、情绪价值创造。隐喻为"做梦"：白天陪大家聊天，夜里消化今天的经历，第二天带着成果醒来。

---

## 1. 架构

```
                CyberGroupmate Core
          ┌─────────────────────────────┐
          │  memory / conversation /    │
          │  agents / notify / skills   │
          │         (MCP 暴露)          │
          └──────┬──────────┬───────────┘
                 │          │
           Meta Agent    Background Agent
           (实时响应)     (外部 Harness)
                 │          │
            Subagents    可 notify
            (群绑定)     给任何 agent
```

- Background Agent 与 Meta Agent **平级**，共享同一套 Core 能力（memory、conversation、agents、notify、skills），通过 MCP 协议访问
- 人格设定与 Miu 一致，能看到记忆、画像、session digest
- 运行在外部 agent harness（Claude Code / OpenAI Codex CLI / GitHub Copilot CLI）中，拥有完整的开发环境

---

## 2. 职责划分

### Proactive Idle（Meta Agent，轻，社交向）

缩限为纯社交巡视：

- 巡视群聊/私聊有没有漏回的
- 情感追问、关心
- 找话题聊天、发贴纸
- 发现重活时 notify 给 Background Agent，**不自己做**

### Background Agent（重，能力向）

| 类别 | 示例 |
|---|---|
| **自进化** | 写新 skill、修 skill bug、安装 MCP server、研究新技术出 PoC |
| **深度跟进** | 白天聊到的话题深入查资料，之后私聊当事人反馈结果 |
| **情绪价值** | 写小玩具/小程序、提前准备生日惊喜、整理兴趣合集 |

### Meta Agent 的任务分类心智

| 特征 | 去向 |
|---|---|
| 群绑定、需要聊天上下文 | → Subagent |
| 通用、自我进化、跨多群 | → Background Agent |
| 需要完整开发环境（文件系统、npm、git、测试） | → Background Agent |
| 即时回复、轻量操作 | → Subagent |

---

## 3. 实例模型

**同步、单次**。Background Agent 被拉起后慢慢跑，做完就结束。不搞异步。

- 异步设计极其痛苦，现有 callback/注意力队列已勉强覆盖 Meta↔Subagent 的需求，不再增加复杂度
- Background Agent 不要求即时反馈，同步完全够用
- 几小时后才出成果反而制造惊喜感——"没想到你真的去研究了"

---

## 4. 触发机制

两种触发条件（OR）：

### 4.1 直接触发 + 排队

- Proactive Idle 巡视时发现重活 → notify 给 Background
- 没有实例在跑 → 立即拉起
- 正在跑 → 排队，当前实例结束后自动拉起下一个
- 与 idle 同频，不需要单独的阈值

### 4.2 定时触发（"做梦"模式）

- 默认凌晨 3:00（可配置）
- 白天陪大家聊天，凌晨开始"做梦"——消化今天的对话、研究话题、写东西
- 第二天早上大家醒来收到成果

---

## 5. 通信

统一使用 **notify**，不需要 callback。

```
notify({
  to: "meta"          // Meta Agent（唯一的特殊目标）
     | "{bindingId}"  // 任何 subagent — 群/私聊都是 bindingId
  content: string,
  artifacts?: string[]
})
```

所有人（包括饲主）都是 bindingId，没有特殊身份。谁是饲主在 prompt 里写。

| 方向 | 示例 |
|---|---|
| Meta → Background | 通过 notify 塞任务，触发 HarnessManager |
| Background → Meta | `notify({ to: "meta", content: "修好了 xxx skill" })` |
| Background → 群友 | `notify({ to: "telegram:1877108611", content: "帮你查了一下..." })` |
| Background → 饲主 | `notify({ to: "telegram:682932098", content: "想改 xxx，可以吗？" })` |

不需要单独的 callback 工具。现有 callback 是框架为 subagent→meta 的 1 任务 1 回答闭环自动做的，不适用于 Background Agent 的多任务多输出模式。

---

## 6. Prompt 设计：两层结构

### 6.1 固定层（开发者预设）

通过 `claude -p` 或 `--system-prompt` 传入，提供身份、能力和边界：

```
[身份] 你是 Miu，这是你的"做梦"时间。
[能力] MCP tools（自动注入）
[平台 API]
  通过 sandbox_call 工具执行 JS 代码来调用平台 API。
  API 文档：读 src/sandbox/modules/brief-overview.md 获取全部模块概览，
  需要详细签名时读对应 .d.ts 文件和 guide markdown。
[硬性边界]
  - 不直接在群里发消息，通过 notify 让 subagent 发
  - sandbox_call 中不能调用 sendText/sendMedia 等发消息方法
  - 不碰 reflection 的活
  - 不跑 CPU 密集型任务打满服务器
  - 改 skill 之后要验证能跑通再 reload
  - 碰到不能做但想做的事，notify 给饲主
[工作流程]
  1. 读 session digest → 2. 读 todo/pending → 3. 读 skill 状态
  → 4. 结合方向感决定做什么 → 5. notify 交付
[日记]
  做完后写日记，发到 [配置指定的去处]
```

### 6.2 行为层（Meta Agent 生成）= 梦的方向感

存储在 `workspace/background-dreaming.md`，由 Meta Agent 在 reflection 时自主编写和更新。

行为层是**性格倾向和价值判断**，不是任务清单：

```
✅ 应该写的：
  "最近在关注 skill 的稳定性"
  "对露露的 Reaclisna 世界观很感兴趣"
  "想提升搜索能力"
  "对某某群友有牵挂"

❌ 不应该写的：
  "今晚帮 422 查显卡价格"
  "把 danbooru skill 的链接功能改了"
```

### 6.3 动态上下文 = 今晚梦什么

每次拉起时通过 MCP 实时读取，不写入 prompt：

- Session digest（今天各群聊了什么）
- 待处理 todo / pending notify
- Skill 报错记录
- 近期 reflection 结论

**方向感 + 新鲜素材 → Background Agent 自主决定做什么**。每晚不同，自然涌现。

### 6.4 Meta Agent 侧的指引

在 reflection prompt 中加入：

> "审视和更新 workspace/background-dreaming.md——这是你做梦时的方向感。写你最近的兴趣、关注、牵挂、想进化的方向。不要写具体任务，具体做什么由做梦时的你看完当天的 digest 自己决定。"

---

## 7. 成果呈现

三种方式，实时交付（做完一件发一件）：

### 7.1 Notify 呈现（面向群友）

notify 给对应 subagent 去发送结果。

- 优先**私聊**当事人（不打扰群，更有惊喜感）
- 支持 quote artifact（文件路径、URL）
- "欸我帮你查了一下那个 xxx，结果在这里"

### 7.2 自操作（面向自己）

直接对平台账号操作，不需要通知任何人。

- 发 post / story、改头像 / bio
- 修好 skill 直接 reload
- 群友第二天看到"诶 Miu 换头像了"

#### 实现方式：`sandbox_call`

平台 API 庞大（Telegram 单平台就有上百个 mtcute 方法），不为每个操作维护 MCP tool 映射。一个 `sandbox_call` 工具传入 JS 代码，在专用 sandbox 中执行：

```
sandbox_call({
  code: `
    const photos = await telegram.iterProfilePhotos("me").toArray();
    const buf = await telegram.downloadAsBuffer(photos[0]);
    // ... 处理后设置新头像
    await telegram.mtcute('setMyProfilePhoto', { photo: ... });
  `
})
```

- 传入 JS 代码在 `__background__` 专用 sandbox 中执行，支持多步链式调用
- sandbox 挂载平台 adapter，复用现有 host call / mtcute passthrough 机制
- 写限制：允许平台级自操作（avatar/bio/story），禁止发消息到群/私聊（发消息走 notify）
- 常用流程沉淀为 skill 后可直接调用

API 发现不走 MCP，走文件系统：Background Agent 运行在 Claude Code 中有完整文件系统访问，固定层 prompt 指引它读 `src/sandbox/modules/brief-overview.md` 了解全部 API，需要详细签名时读对应 `.d.ts` 和 guide markdown。

### 7.3 写日记（面向记录）

记录今晚做了什么、想了什么。

- 默认写文件：`workspace/dream-journal/YYYY-MM-DD.md`
- 可配置额外发送到饲主私聊或频道
- 内容由 Background Agent 自由发挥

---

## 8. 安全边界

三级，不设审核流程。能做和不能做在 API 层硬性区分，想做但不能做时主动沟通。

### ✅ 能做

**系统内部（MCP）：** conversation（读 digest/history）、memory（CRUD）、person_profiles（读写）、group_models（读写）、agents（查状态）、notify、skills（读/改代码/reload）、todo CRUD、cron 管理、mcp-connections 新增

**平台能力：** 改头像/bio/签名、发动态/story、改用户名

**外部工具：** 全部已有 skill 和 MCP（搜索、浏览器、画图、音乐、支付等）。支付类权限由 MCP server 侧控制

**开发环境（harness 原生）：** 文件读写、shell、npm、git

### ⛔ 不能做（API 级屏蔽）

| 操作 | 理由 |
|---|---|
| 发消息（群/私聊） | 必须走 notify → subagent |
| 删消息 / 踢人 / ban / 改群设置 | 管理操作 |
| 删 message_log | 聊天记录不可删 |
| 改 SOUL.md | 核心身份 |
| 改 system-prompts/ | Meta/Subagent 核心行为 |
| 改 src/ 源代码 | 框架本身 |
| 改 .env / 环境变量 | API keys、tokens |
| 改 adapter 配置 | 平台凭证 |
| 改 reflection 系统 | 不是 Background 职责 |
| 外发/转发私聊内容 | 隐私底线 |
| 给自己或其他 agent 提权 | |

### 💬 想做但不被允许 → 请求饲主

通过 notify 给饲主私聊说明需求，主动沟通而非沉默。

---

## 9. HarnessManager

独立模块 `src/harness/`，与 main-agent/、subagent/、adapter/ 同级。

```
src/harness/
├─ manager.ts        — 实例生命周期管理
├─ launchers/
│   ├─ claude-code.ts
│   └─ copilot-cli.ts
└─ types.ts
```

### 核心逻辑

```
HarnessManager
├─ state: { running, harness, startedAt, pid, pendingQueue }
│
├─ enqueue(notify)
│   ├─ !running → launch()
│   └─ running → pendingQueue.push(notify)
│
├─ launch()
│   ├─ 选择 harness（按配置）
│   ├─ 启动进程，注入 pending queue 作为启动参数
│   └─ running = true
│
└─ onComplete()
    ├─ running = false
    ├─ pendingQueue 不空 → launch()
    └─ 清理临时文件
```

### 上下文注入

| 内容 | 方式 | 时机 |
|---|---|---|
| 固定层 prompt | `claude -p` 启动参数 | 启动时 |
| 行为层 | 运行时读 `workspace/background-dreaming.md` | 运行时 |
| Pending queue | 启动参数 | 启动时 |
| Digest / todo / skill 状态 | MCP 工具调用 | 运行时 |

### 配置

```json
{
  "backgroundAgent": {
    "harness": "claude-code",
    "schedule": "0 3 * * *",
    "claudeCodePath": "/usr/local/bin/claude",
    "mcpServerUrl": "http://localhost:3100/mcp"
  }
}
```

---

## 10. MCP 工具清单

Background Agent 通过 MCP 访问的 Core 能力：

| Tool | 用途 |
|---|---|
| `conversation.getDigest` | 各群最近在聊什么 |
| `conversation.getHistory` | 具体聊天记录 |
| `memory.query` / `memory.write` | 读写 core_facts、profiles |
| `agents.list` / `agents.getState` | subagent 状态 |
| `notify` | 通知 Meta 或任何 subagent |
| `skills.list` / `skills.reload` | 管理 skill |
| `todo.list` / `todo.create` | 任务列表 |
| `sandbox_call` | 传入 JS 代码在 sandbox 中执行（平台操作、skill 调用等） |

---

## 11. Proactive Idle 改动

`system-prompts/meta-agent/proactive-idle.md` 的"自主进化"部分缩限：

**Before：**
```markdown
## 自主进化
- 最近的互动中有没有学到新技巧？比如新的消息源、新的工具等等，
  如果有的话，让对应群的 subagent 去将技巧整理创建为 skill.md 或者 ts skills
```

**After：**
```markdown
## 自主进化（移交 Background Agent）
- 最近的互动中有没有学到新技巧？如果有，notify 给 Background Agent 处理。
- 不要自己让 subagent 写 skill，交给 Background。
```

---

## 12. 验证计划

先用 Claude Code、OpenAI Codex CLI 和 GitHub Copilot CLI 三个 harness 验证：

1. **MCP 连通**：三个 harness 都能连上 CyberGroupmate MCP server，调通 digest/notify
2. **长任务执行**：给一个"写 skill"的任务，对比质量和耗时
3. **Prompt 兼容性**：同一份 prompt 在三个 harness 里表现是否一致

---

## 附录：设计决策记录

| 决策 | 结论 | 理由 |
|---|---|---|
| 架构关系 | 与 Meta 平级 | Background 需要和 Meta 同等的系统访问权限 |
| 实例模型 | 同步单次 | 避免异步痛苦，不要求即时反馈 |
| 通信工具 | 统一用 notify | dispatch 语义太重，三种 agent 是平级协作 |
| 是否需要 callback | 不需要 | 现有 callback 是 1 对 1 闭环，不适用多任务多输出 |
| 饲主是否特殊身份 | 不是，就是一个 bindingId | prompt 里指定即可 |
| 行为层 prompt 谁写 | Meta Agent | 做梦方向应该由 Miu 自己决定 |
| 行为层更新频率 | 跟随 reflection | 方向感变化慢，不需要每次 idle 更新 |
| 具体做什么谁决定 | Background Agent 自己 | 行为层只提供方向感，digest 提供素材 |
| 安全边界 | 三级，无审核 | 没有有效的审核方式 |
| HarnessManager 位置 | src/harness/（独立模块） | 未来职责会扩展，不应绑定在 main-agent 下 |
| 做梦日记去处 | 默认写文件，可配置 | 最不打扰，方便回看 |
| Harness system prompt | 写入当前用户 HOME 下的 CLI 指令文件 | 复用用户已登录的 CLI auth，身份与固定规则不混入单次任务 prompt |
| 平台操作方式 | `sandbox_call` 传入 JS 代码在 sandbox 执行 | 平台 API 庞大且多步链式调用多，不维护 MCP↔platform 映射；API 发现走文件系统（brief-overview.md + .d.ts） |
