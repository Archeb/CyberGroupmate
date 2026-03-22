关于主 Agent 是否需要CodeAct 我的想法是：要，但是他不能干扰主注意力循环。但同时要具有解决跨场景的问题解决能力。(比如A群要求给B群传话，或者同样一个人在A群说要睡觉，扭头在B群又聊起来，agent想要吐槽一下；再比如说用户在私聊里让agent完成了一个任务比如说视频转码，然后在大群里面@agent让他把刚才在私聊里弄好的东西发到大群里；等等这些场景)
让我们从更高的，更宏观的视角来看待这件事。
main agent和subagent的视角很窄但是很实时，他们无论如何都需要及时对用户行动产生响应，不能阻塞。
但是，coding agent并不需要，当我们使用antigravity、claude code给agent下任务的时候，agent都会慢慢的去确认整个codebase情况。然后再做出行动。
我们不能要求一个本身就是实时、快的两个agent去做这个事情。我们必须有一个能慢的，独立的agent，在接收到这种任务的时候，在后台慢慢查，查完了告诉main agent, 然后main agent再回群里把结果发出去。
这有两个点需要说明：
1. coding agent 他得视野为何？答：应该是整个框架的运行时日志、数据库db（并且提供读写db工具）、整个workspace下面的文件系统和shell。能让他充分的理解当前的环境，而不是运行在sandbox里。说白了：我们甚至可以直接外接一个opencode或者claudecode做这个事情，当然自己做也没问题。
2. coding agent、main agent和subagent之间的Agent to Agent沟通应该遵循什么样的范式？我暂时没想的很清楚，但是从正常人行为方式来看，main agent应该能确认当前任务执行状态（coding agent会展示brief、和当前的task完成情况），然后通过sub agent把情况告知用户。用户询问的时候main agent能告诉她：你的任务已经跑到哪一步了。但是具体这些agent之间怎么沟通，还需要进一步思考和在实践中检验。我们可以先头脑风暴然后充分考虑沟通和需求的各种需要。

claude:

# 三速认知架构：Reflexive / Deliberative / Investigative

## 你点出了一个根本性的问题

现有两层架构的速度光谱是连续但窄的：

```
SubAgent FastPath     Main Agent LLM决策     SubAgent CodeAct
   ~200ms               ~2-5s                 ~10-60s
   ←──────────────── "实时频段" ──────────────────→
```

所有组件都被绑在"实时响应"这根弦上。CodeAct 看起来能做复杂任务，但它本质上还是一个**在沙盒里快速执行预定义 API 的回复生成器**——它不能花 5 分钟翻遍数据库，不能跑 shell 命令做视频转码，不能慢慢阅读整个 workspace 理解上下文。

人类处理请求有三种模式：

| 模式 | 人类类比 | 当前架构 | 缺口 |
|------|---------|---------|------|
| **反射** | 脱口而出 | FastPath ✅ | — |
| **思考** | 想几秒钟再回答 | Main Agent + CodeAct ✅ | — |
| **调研** | "我去查查，回头告诉你" | ❌ **没有** | **这就是缺的** |

---

## Background Agent 的本质

它不是一个更大的 sandbox。它是一个**拥有完整环境访问权的独立 Agent 进程**，像你坐在电脑前用 Claude Code 干活一样。

```
┌─ Background Agent 的视野 ─────────────────────────┐
│                                                     │
│  📁 Filesystem (整个 workspace)                     │
│     ├── data/memory.db (SQLite — 直接读写)          │
│     ├── data/message_log/ (全量消息历史)             │
│     ├── data/sessions/ (CodeAct 历史 session)       │
│     ├── logs/ (运行时日志)                          │
│     ├── config/ (所有配置)                          │
│     └── agent-docs/ (文档)                          │
│                                                     │
│  🐚 Shell (可以跑任意命令)                          │
│     ├── ffmpeg (视频/音频处理)                       │
│     ├── git (版本控制操作)                           │
│     ├── curl / wget (网络请求)                      │
│     ├── python / node (脚本执行)                    │
│     └── ... anything                                │
│                                                     │
│  🌐 Network (无限制)                               │
│     ├── Web 搜索和爬取                              │
│     ├── API 调用                                    │
│     └── 下载/上传                                   │
│                                                     │
│  📊 Database (直接 SQL)                             │
│     ├── SELECT * FROM message_log WHERE ...          │
│     ├── SELECT * FROM topics WHERE ...               │
│     ├── SELECT * FROM person_profiles WHERE ...      │
│     └── 甚至可以写入 (插入 core_facts 等)           │
│                                                     │
│  📋 Task Board (与 Main Agent 的通信界面)            │
│     ├── 读取任务描述和上下文                         │
│     ├── 更新进度和中间发现                           │
│     └── 提交最终结果 / 请求用户输入                  │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**对比 CodeAct Sandbox：**

| | CodeAct Sandbox | Background Agent |
|---|---|---|
| 环境 | 隔离沙盒, Worker 线程 | 完整系统, 独立进程 |
| 文件系统 | 无 | 完整读写 |
| Shell | 无 | 有 |
| 数据库 | 通过 host-call 间接访问 | 直接 SQL 读写 |
| 时间预期 | 秒级 | 分钟到小时级 |
| 并发模型 | per-group, 多个同时 | 全局, 少量并发 (1-3) |
| 身份 | 替某个群生成回复 | 执行系统级任务 |
| 外接可能 | 不可能 | 可以是 Claude Code / OpenCode |

---

## Agent-to-Agent 通信：Task Board 范式

我想先从人类行为模式出发，然后映射到技术实现。

### 人类是怎么委派和跟进的

```
场景：产品经理（Main Agent）委派给研究员（Background Agent），
      同时向客户（用户）汇报。

1. PM 收到客户需求："帮我调查一下竞品的定价策略"
   PM → 客户: "好的，我安排人去调查，大概需要半小时"
   PM → 研究员: "任务简报：调查竞品A/B/C的定价，重点看企业版"

2. 研究员开工，每隔一段时间在共享文档里更新进度：
   📝 "已经找到竞品A的公开定价页面，正在分析"
   📝 "竞品B需要注册才能看到价格，正在处理"
   
3. 客户追问："搞得怎么样了？"
   PM 打开共享文档，看到最新进度
   PM → 客户: "竞品A已经查完了，B还在弄，再等15分钟"

4. 研究员遇到问题：
   📝 "竞品C有两个不同版本的定价，需要确认客户要的是哪个"
   → 标记任务状态为 NEEDS_INPUT
   
5. PM 在下次跟客户沟通时提到：
   PM → 客户: "竞品C有两个版本，你要的是国际版还是国内版？"
   客户: "国际版"
   PM → 共享文档: 补充信息 "客户确认要国际版"
   → 标记任务状态回 IN_PROGRESS

6. 研究员完成：
   📝 最终报告 + 附件（截图/表格）
   → 标记 COMPLETED
   
7. PM 看到完成：
   PM → 客户: "结果出来了: [摘要]，详细的我发文件给你"
```

**这里的关键模式是**：
- **异步**：PM 不会站在研究员旁边等
- **Task Board 是共享状态**：双方都能读写，是唯一的沟通信道
- **PM 主动轮询或被动通知**：不是实时推送，而是"下次有机会时查看"
- **向客户汇报是 PM 的职责**：研究员不直接跟客户说话
- **澄清请求要绕路**：研究员 → Task Board → PM → 用户 → PM → Task Board → 研究员

### 映射到系统架构

```mermaid
graph TB
    subgraph User_Facing["用户感知层"]
        USER["用户 (各个群/私聊)"]
    end

    subgraph Realtime["实时层 (毫秒~秒)"]
        MA["Main Agent<br/>产品经理"]
        SA["SubAgent CodeAct<br/>即席执行"]
        FP["FastPath<br/>条件反射"]
    end

    subgraph Background["后台层 (分钟~小时)"]
        BA["Background Agent<br/>研究员/工程师"]
    end

    subgraph Shared["共享通信层"]
        TB["📋 Task Board<br/>(持久化任务状态)"]
    end

    USER <-->|"群消息/私聊"| MA
    MA -->|"即席任务"| SA
    MA -->|"预授权"| FP
    
    MA -->|"创建任务<br/>写入 brief + context"| TB
    MA -->|"写入用户澄清"| TB
    MA <--|"读取进度/结果"| TB

    BA -->|"更新进度"| TB
    BA -->|"提交结果"| TB
    BA -->|"请求用户输入"| TB
    BA <--|"读取任务 + 澄清"| TB

    SA -->|"发消息"| USER
    FP -->|"快回"| USER
    MA -.->|"转达结果"| SA
```

---

## Task Board 核心设计

### 数据模型

```typescript
interface BackgroundTask {
  id: string;
  
  // ── 任务定义 ──
  brief: string;              // Main Agent 写的任务简报
  context: {                  // 任务产生的上下文
    originChatId: string;     // 哪个群/私聊发起的
    originMessageIds: number[]; // 触发消息
    requestedBy: string;      // 请求者 personId
    relevantChatIds?: string[]; // 涉及的其他群
    attachments?: string[];   // 附件 (file IDs, paths)
  };
  
  // ── 生命周期 ──
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  estimatedDuration?: string; // "约5分钟" — BA 填写
  deadline?: number;
  
  // ── 进度日志 (核心通信载体) ──
  journal: JournalEntry[];
  
  // ── 结果 ──
  result?: TaskResult;
}

type TaskStatus = 
  | "QUEUED"          // 等待 BA 接手
  | "ACKNOWLEDGED"    // BA 已看到，即将开始
  | "IN_PROGRESS"     // 执行中
  | "NEEDS_INPUT"     // 需要用户/MA 提供更多信息
  | "COMPLETED"       // 完成
  | "FAILED"          // 失败
  | "CANCELLED";      // 被取消

interface JournalEntry {
  timestamp: number;
  author: "MAIN_AGENT" | "BACKGROUND_AGENT" | "USER";  
  type: "PROGRESS" | "DISCOVERY" | "QUESTION" | "ANSWER" | "ERROR" | "NOTE";
  content: string;
  metadata?: Record<string, any>;  // 结构化数据
}

interface TaskResult {
  summary: string;            // 一句话结果，MA 可以直接转述
  detail?: string;            // 详细内容
  artifacts?: Array<{         // 产出物
    type: "FILE" | "IMAGE" | "TEXT" | "DATA";
    description: string;
    reference: string;        // file path / telegram file ID / inline content
  }>;
  followUp?: string;          // BA 建议的后续动作
}
```

### 持久化：就是文件系统

每个任务一个目录，简单粗暴，Background Agent 可以直接用文件系统操作：

```
data/tasks/
├── task_2026-03-19_001/
│   ├── task.json              # BackgroundTask 完整结构
│   ├── journal.jsonl          # append-only 进度日志
│   ├── workspace/             # BA 的工作目录 (临时文件/中间产物)
│   │   ├── downloaded_video.mp4
│   │   ├── output.gif
│   │   └── search_results.md
│   └── result/                # 最终交付物
│       ├── summary.md
│       └── output.gif
└── task_2026-03-19_002/
    ├── task.json
    ├── journal.jsonl
    └── ...
```

**为什么不用数据库？** 因为 Background Agent 的核心优势就是能直接操作文件系统。task 目录就是它的工作空间。JSON + JSONL 是最简单的人和机器都能读的格式。Claude Code / OpenCode 也能直接读写这些文件。

---

## 三种 Agent 的通信协议

### Main Agent → Background Agent：任务创建

```typescript
// dispatch-handler.ts 中新增
case "BACKGROUND_TASK": {
  const task: BackgroundTask = {
    id: generateTaskId(),
    brief: decision.brief,
    context: {
      originChatId: chatId,
      originMessageIds: decision.targetMessageIds,
      requestedBy: decision.requesterId,
      relevantChatIds: decision.relevantChatIds,
    },
    status: "QUEUED",
    journal: [{
      timestamp: Date.now(),
      author: "MAIN_AGENT",
      type: "NOTE",
      content: decision.brief,
    }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  
  await taskBoard.create(task);
  
  // 同时通过 SubAgent 即时回复用户
  // "好的，我去查一下，稍等"
  if (decision.immediateAck) {
    codeActExecutor.enqueue({
      type: "CODEACT_REPLY",
      contentDirection: decision.immediateAck,
      // e.g. "告诉用户你已经开始处理了，预计几分钟"
    });
  }
  break;
}
```

### Background Agent → Main Agent：进度更新

Background Agent 不需要特殊 IPC。它只需要往 `journal.jsonl` 追加行：

```jsonl
{"timestamp":1710841200,"author":"BACKGROUND_AGENT","type":"PROGRESS","content":"正在搜索 message_log，已查询 A群 3月份消息"}
{"timestamp":1710841260,"author":"BACKGROUND_AGENT","type":"DISCOVERY","content":"找到 3 条相关消息，用户 2月15日提到过这个餐厅叫'外婆家'"}
{"timestamp":1710841320,"author":"BACKGROUND_AGENT","type":"PROGRESS","content":"正在交叉验证 B群的讨论记录"}
```

**Main Agent 怎么知道有更新？**

Phase 1 或 Phase 2 中加一步：

```typescript
// main-agent-loop.ts Phase 1.5
const updatedTasks = taskBoard.pollUpdates(); 
// 扫描所有 active task 的 journal.jsonl 
// 检查 mtime 或 最后读取位置

for (const task of updatedTasks) {
  if (task.status === "COMPLETED") {
    // 结果可用 → boost origin chat 到 Q3
    // 下次 attend 时 prompt 里会出现结果
    attentionQueue.enqueueOrBoost(task.context.originChatId, {
      reason: `background task completed: ${task.brief}`,
      metadata: { taskId: task.id, result: task.result }
    });
  }
  
  if (task.status === "NEEDS_INPUT") {
    // BA 有问题要问用户 → 同样 boost origin chat
    attentionQueue.enqueueOrBoost(task.context.originChatId, {
      reason: `background task needs input: ${task.id}`,
      metadata: { taskId: task.id, question: task.journal.at(-1)?.content }
    });
  }
  
  // 更新 GlobalState 供 system prompt 注入
  globalState.updateTaskStatus(task.id, task.status, latestJournalEntry);
}
```

### User → Background Agent：澄清回答

这条路最长：用户 → 群消息 → NC → Main Agent attend → 写入 Task Board → Background Agent 读取

```
用户在群里: "国际版的"
       ↓
Main Agent attend, prompt 中有:
  "Background Task task_001 状态: NEEDS_INPUT
   问题: '竞品C有两个版本，国际版还是国内版？'
   本群最新消息: 用户说 '国际版的'"
       ↓
Main Agent 决策: 
  { action: "ANSWER_BACKGROUND_TASK", 
    taskId: "task_001",
    answer: "用户确认要国际版" }
       ↓
dispatch-handler: 
  taskBoard.appendJournal("task_001", {
    author: "USER",
    type: "ANSWER", 
    content: "用户确认要国际版"
  });
  taskBoard.updateStatus("task_001", "IN_PROGRESS");
       ↓
Background Agent 下次轮询 journal 发现新 ANSWER，继续工作
```

---

## Background Agent 本体：几种实现路径

### 路径 1：外接 Claude Code / OpenCode（最快上线）

```typescript
class BackgroundAgentSpawner {
  async spawn(task: BackgroundTask): Promise<ChildProcess> {
    const taskDir = `data/tasks/${task.id}`;
    
    // 生成 prompt 文件
    await writeFile(`${taskDir}/TASK.md`, this.renderTaskPrompt(task));
    
    // 直接启动 claude code CLI
    const proc = spawn("claude", [
      "--task-file", `${taskDir}/TASK.md`,
      "--cwd", taskDir,
      "--output", `${taskDir}/result/`,
      // 告诉它可以访问上级目录的数据库
      "--allow-read", "../../data/",
      "--allow-write", `${taskDir}/`,
    ]);
    
    // 监控进程输出，解析进度 → 写入 journal
    proc.stdout.on("data", (chunk) => {
      this.parseAndJournal(task.id, chunk.toString());
    });
    
    return proc;
  }
  
  private renderTaskPrompt(task: BackgroundTask): string {
    return `
# Task Brief
${task.brief}

# Context
- Requested by: ${task.context.requestedBy} in chat ${task.context.originChatId}
- Related chats: ${task.context.relevantChatIds?.join(", ")}

# Available Resources
- SQLite database: ../../data/memory.db
  - Tables: message_log, topics, person_profiles, core_facts, group_models
- Message logs: ../../data/message_log/
- Runtime logs: ../../logs/

# Communication
- Write progress to: journal.jsonl (JSONL format, append only)
  Format: {"timestamp":epoch,"author":"BACKGROUND_AGENT","type":"PROGRESS|DISCOVERY|QUESTION|ERROR","content":"..."}
- If you need user input, write a QUESTION entry and update task.json status to "NEEDS_INPUT"
- When done, write results to result/ directory and update task.json status to "COMPLETED"

# Task workspace
You may create any files in this directory for intermediate work.
    `;
  }
}
```

**好处**：几乎零开发量。Claude Code 自带文件操作、shell、思考链。
**风险**：进度日志格式可能不可控；需要它"遵守"journal 协议；成本（每个任务一个完整 Claude session）。

### 路径 2：自建 CodeAct（无沙盒版）

复用现有的 session-runner 模式，但赋予完整系统权限：

```typescript
class BackgroundAgentRunner {
  private llm: LLMClient;
  
  async run(task: BackgroundTask): Promise<TaskResult> {
    const systemPrompt = this.buildSystemPrompt(task);
    const messages: Message[] = [{ role: "system", content: systemPrompt }];
    
    // 工具定义 — 不是 host-call，是直接执行
    const tools = {
      "shell": async (cmd: string) => {
        // 直接执行 shell 命令
        return execSync(cmd, { cwd: task.workspace, timeout: 60000 }).toString();
      },
      "sql": async (query: string) => {
        // 直接查询 SQLite
        return db.prepare(query).all();
      },
      "read_file": async (path: string) => {
        return readFile(resolve(task.workspace, path), "utf-8");
      },
      "write_file": async (path: string, content: string) => {
        await writeFile(resolve(task.workspace, path), content);
      },
      "web_search": async (query: string) => { /* tavily */ },
      "web_fetch": async (url: string) => { /* fetch + readability */ },
      "journal": async (type: string, content: string) => {
        await this.appendJournal(task.id, {
          author: "BACKGROUND_AGENT",
          type, content,
          timestamp: Date.now()
        });
      },
      "ask_user": async (question: string) => {
        await this.appendJournal(task.id, {
          author: "BACKGROUND_AGENT",
          type: "QUESTION", content: question,
          timestamp: Date.now()
        });
        await this.updateStatus(task.id, "NEEDS_INPUT");
        // 等待回答 — 轮询 journal 直到收到 ANSWER
        return this.waitForAnswer(task.id, { timeout: 30 * 60 * 1000 });
      },
    };
    
    // 多轮循环 — 和 session-runner 类似但不限轮次
    while (true) {
      const response = await this.llm.call(messages, { tools });
      
      if (response.toolCalls) {
        for (const call of response.toolCalls) {
          const result = await tools[call.name](call.args);
          messages.push(toolResultMessage(call.id, result));
        }
        continue;
      }
      
      // 无工具调用 → 任务完成
      return this.parseResult(response.content);
    }
  }
}
```

**好处**：完全可控的协议、进度汇报、工具集。
**风险**：要自己做安全边界（shell 命令白名单？SQL 写入限制？）。

### 路径 3：混合——自建调度 + 外接执行

```
自建 TaskBoard + 调度器 (轻量)
         ↓
外接执行引擎 (可替换):
  ├── Claude Code (默认，重任务)
  ├── OpenCode (备选)
  ├── 自建 Runner (轻量任务)
  └── 甚至人工 (紧急时 admin 手动完成，写 journal 标记 COMPLETED)
```

这个最灵活。TaskBoard 和通信协议是自己的，执行引擎可以换。

---

## Agent-to-Agent 沟通的深度思考

### 信息密度层级

不同场景下，Agent 之间需要传递的信息密度差异巨大：

```
Level 0 — 状态信号:
  "task_001 状态变为 COMPLETED"
  → 一个 enum 值就够
  → Main Agent Phase 1 轮询

Level 1 — 进度摘要:
  "已搜索完 A群 3月消息，找到 3 条相关记录，正在分析 B群"
  → 一句话
  → 用户问进度时 Main Agent 可直接转述

Level 2 — 发现报告:
  "找到以下关键信息：
   1. 2月15日 老王在C群说过'下次去外婆家吧'
   2. 3月2日 小李在A群回复'外婆家那个在中山路的关了'
   结论：餐厅叫外婆家，但可能已关闭"
  → 结构化发现
  → Main Agent 需要理解并决定怎么回复用户

Level 3 — 交互请求:
  "竞品C有国际版和国内版两种定价体系，
   国际版 $49/mo, 国内版 ¥199/年
   需要用户确认查哪个？
   [等待回答后继续]"
  → 需要用户参与的阻塞交互
  → Main Agent 要在合适时机转达问题，收到回答后写回 journal

Level 4 — 结果 + 制品:
  "任务完成。视频已转码为 GIF (result/output.gif, 2.3MB)。
   同时发现原视频分辨率过高 (4K)，已自动压缩到 720p。
   建议：如果用户经常有转码需求，可以默认使用 720p。"
  → 结果 + 附件 + 建议
  → Main Agent 需要组织回复 + 传送文件
```

### Main Agent Prompt 中的任务感知

```
# System Prompt 中新增段落

## Active Background Tasks
{{#each activeTasks}}
### Task: {{this.id}} — {{this.brief}}
- Status: {{this.status}}
- Started: {{timeSince this.createdAt}} ago
- Requested by: {{this.context.requestedBy}} in {{this.context.originChatName}}
{{#if this.latestJournal}}
- Latest update: {{this.latestJournal.content}}
{{/if}}
{{#if (eq this.status "NEEDS_INPUT")}}
⚠️ This task is BLOCKED waiting for user input. 
Question: "{{this.pendingQuestion}}"
When you attend the origin chat, ask the user and use ANSWER_TASK action.
{{/if}}
{{#if (eq this.status "COMPLETED")}}
✅ Result ready! When you attend the origin chat, deliver the result.
Summary: {{this.result.summary}}
{{#if this.result.artifacts}}
Artifacts: {{#each this.result.artifacts}}[{{this.type}}: {{this.description}}] {{/each}}
{{/if}}
{{/if}}
{{/each}}
```

Main Agent attend 到对应群时，自然就知道该做什么。

### 用户追问的处理流

这是最有意思的交互。用户说"那个弄好了吗？"时：

```
用户: "@agent 刚才让你查的东西弄好了没"
                ↓
NC → Observer → Q3
                ↓
Main Agent attend, prompt 中包含:
  - 群消息: 用户问 "刚才让你查的东西弄好了没"
  - Active Background Tasks: task_001, status=IN_PROGRESS,
    latest: "已找到 A群相关记录，正在分析 B群"
                ↓
Main Agent 决策:
  { action: "REPLY",
    contentDirection: "告诉用户任务还在进行中，
    目前已经找到了 A群的相关记录，B群还在分析，
    预计还需要几分钟" }
                ↓
SubAgent CodeAct → 发消息
```

**Main Agent 完全不需要自己去查任务状态**——它在 system prompt 里已经看到了。这就是 Task Board 被动注入的力量。

---

## 一个重要的设计问题：Background Agent 能否直接发消息？

两种选择：

### 选择 A：不能——所有用户通信经过 Main Agent

```
BA → TaskBoard → MA → SubAgent → 用户
```

**好处**：
- Main Agent 保持对所有对外通信的控制权
- 语气、时机、persona 一致性有保障
- 不会出现 BA 在不恰当的时机发消息（比如群里正在吵架时突然插一个任务结果）

**坏处**：
- 延迟——BA 完成后要等 MA 下一个 tick attend 到对应群才能传达
- 如果任务很急，这个延迟可能不可接受

### 选择 B：可以——但受限

```
BA 可以通过 NC 直接发消息，但只在这些条件下:
  1. 任务标记了 urgent=true
  2. 只能发到 origin chat
  3. 发送前通知 Main Agent (写入 journal + 事件)
  4. 发送的内容遵循 persona 模板
```

### 选择 C：混合——结果投递由 Main Agent 编排，但 BA 可以先准备好

```
BA 完成后:
  1. 将结果写入 TaskBoard
  2. 创建一个 "draft reply" (含消息文本 + 附件)
  3. Main Agent attend 时看到 draft，可以:
     a. 原样批准发送
     b. 修改后发送  
     c. 决定不发送 / 延迟发送
```

**我倾向于选择 C**。它保持了 Main Agent 的最终决策权，同时 BA 可以减轻 Main Agent 的负担（不用现场组织回复内容，直接审批 draft）。

---

## 总结：三速认知架构

```
               ┌─────────────────────────────┐
               │  🧠 Main Agent (思考)        │
               │  速度: 秒级                  │
               │  职责: 调度 + 感知 + 决策     │
               │  权限: 只读信息 + JSON指令    │
               ├──────────┬──────────────────┤
               │          │                  │
        ┌──────▼──────┐   │    ┌─────────────▼──────────────┐
        │ ⚡ SubAgent  │   │    │  🔬 Background Agent (调研) │
        │ (反射+执行)  │   │    │  速度: 分钟~小时级          │
        │ 速度: ms~分  │   │    │  职责: 深度调查 + 复杂任务   │
        │ 权限: 沙盒API│   │    │  权限: 完整系统访问          │
        └──────┬──────┘   │    └──────────┬─────────────────┘
               │          │               │
               │     ┌────▼────┐          │
               │     │📋 Task  │◄─────────┘
               │     │  Board  │  journal + status + result
               │     └────┬────┘
               │          │
               ▼          ▼
        ┌─────────────────────────┐
        │  👥 用户 (群/私聊)       │
        └─────────────────────────┘
```

### 优先级建议

```
Phase 0 (现在): 确定 Task Board 的数据模型和文件格式
  → 这是三个 Agent 的通信契约，必须先定

Phase 1: 实现 TaskBoard 读写 + Main Agent Prompt 注入
  → 让 Main Agent 能"看到"任务状态
  → dispatch-handler 支持 BACKGROUND_TASK action
  → Main Agent Phase 1 加入 taskBoard.pollUpdates()

Phase 2: 外接 Claude Code 作为 Background Agent
  → 最快拿到执行能力
  → 写好 TASK.md 模板 + journal 解析

Phase 3: 自建 Background Agent Runner (替换/补充 Claude Code)
  → 更可控的成本和协议遵从

Phase 4: 完善交互流
  → NEEDS_INPUT / ANSWER 往返
  → 结果 draft + Main Agent 审批
  → 跨群任务编排
```

### 还需要进一步想清楚的

1. **Background Agent 的 persona**: 它对外（通过 Main Agent 转述）应该是同一个人格，但它内部工作时是用工具人 prompt 还是完整 persona？我倾向于**内部是工具人（高效精准），对外由 Main Agent 加上 persona 包装**。

2. **并发控制**: 同时能跑几个 Background Task？Claude Code 的话成本很高，可能要限制 1-2 个。自建的话可以多一些但要限制资源。

3. **长时任务的中断恢复**: 如果 BA 跑到一半系统重启了怎么办？Task Board 是持久化的所以状态不丢，但 LLM 的对话上下文可能丢失。需要考虑从 journal 恢复的能力。

4. **安全边界**: BA 有 shell 和 DB 写入权限。需不需要白名单/黑名单？还是信任 LLM 不会 `rm -rf /`？如果外接 Claude Code，它自带安全确认机制。

5. **Task Board 的变更通知机制**: Main Agent 轮询 vs 文件系统 watch vs BA 主动推送事件到 NC？轮询最简单但有延迟，watch 零延迟但增加复杂度。

你觉得这个三层架构的方向对了吗？要不要在某些方面再深入展开？