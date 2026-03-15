# Prompt & API 暴露完整审计报告

> 审计范围：subagent.md §12 定义的 7 个 Prompt 注入点，以及 Implementation Plan §1.3/§3 定义的 Dynamic API Surface 机制

---

## 一、Prompt 审计（按 subagent.md §12 的 7 个注入点）

### ➊ Recording Pipeline Triage Prompt — ⚠️ 旧 Pipeline 遗留

| 项目 | subagent.md spec | 实际 |
|------|-----------------|------|
| **位置** | Observer 内部，flush 时 | 旧的 `RecordingPipeline` 全局实例 |
| **Persona** | 不需要（纯分析） | ✅ 不需要 |

**问题**：此 prompt 属于旧 Phase 6A Pipeline，在新架构下由全局 `fastRouter.routeEvents()` 触发而非 per-group Observer 内部调用。这是上份审计报告中 Issue #2（双重 Pipeline）的延伸。

---

### ➋ Main Agent 系统 Prompt — 🔴 完全缺失

**subagent.md §12.2 spec**:
```
[System]
你是 CyberGroupmate 的主调度 Agent。你的职责是快速审视多个群组的消息状态，
做出是否回复、怎么回复的决策，并将执行任务分派给各群组的 Subagent。
...
## 核心规则 (6 条)
## 当前全局状态 {{globalState}}
## 当前任务列表 {{taskList}}
```

**实际** ([main.ts L517](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#L517)):
```typescript
{ role: "system", content: `你是主 Agent 的决策引擎。你需要分析群组上下文并返回 JSON 决策。仅返回 JSON，不要包含其他文本。` }
```

| 缺失项 | 严重度 |
|--------|--------|
| ❌ 无角色设定（CyberGroupmate 是谁） | 🔴 |
| ❌ 无 persona 注入（`config.yaml` 中的性格描述） | 🔴 |
| ❌ 无 6 条核心决策规则 | 🔴 |
| ❌ 无 `globalState` 注入 | 🟡 |
| ❌ 无 `taskList` 注入 | 🟡 |
| ❌ 无粘性/亲密度级别说明 | 🟡 |
| ❌ 无 FastPath 授权规则说明 | 🟡 |

> [!CAUTION]
> 主 Agent 的 system prompt 只有一句话，完全没有角色设定。LLM 不知道自己是谁、在干什么、有什么规则限制。这导致决策质量无法保证，且每次 attend 都是无状态的独立调用。

---

### ➌ Attend 上下文注入 Prompt — 🟡 结构不完整

**subagent.md §12.2 spec** 定义了一个丰富的结构化注入（群组标题、上次关注时间、消息原文、群组画像、Subagent 执行结果、FastPath 历史等）。

**实际** ([subagent-attention.md](file:///Users/moss/Projects/CyberGroupmate/system-prompts/subagent-attention.md))：

| 缺失项 | spec 要求 | 实际 |
|--------|----------|------|
| ❌ 群组标题 | `{{chatTitle}}` | 仅当 `groupModel` 存在时有 `{{chatTitle}}` |
| ❌ 上次关注时间 | `上次关注: {{lastAttendedAt}}` | 完全缺失 |
| ❌ 时间差 | [({{timeSinceLastAttend}} 前)](file:///Users/moss/Projects/CyberGroupmate/src/scenes/shared/runtime.d.ts#21-23) | 完全缺失 |
| ❌ 消息原文 | L2+ 深度时应显示消息 | 完全缺失（模板中没有 messages 部分） |
| ❌ Triage 结果 | 每个话题的 Triage 判断 | `topicDigests` 仅有摘要，无 triage 结果 |
| ❌ 粘性信息 | familiarity / replyFrequency / tonePreset | 完全缺失 |
| ❌ FastPath 历史 | FastPath 回复记录 | 完全缺失 |
| ❌ Persona | Agent 应知道自己是谁才能做合理决策 | 完全缺失 |

**代码问题** ([main.ts L500-510](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#L500-L510)):
```typescript
const promptVars = buildAttentionVariables(contextPkg, entry.newMessageCount);
// 添加最近消息
const recentMsgs = memory.getRecentMessages(entry.chatId, 20);
```
- 消息以 `[user_id] text` 格式呈现，缺少时间戳和发送者 displayName
- `suggestedReplyMode` 被注入变量但 ATTENTION 模板中没有引用它

---

### ➍ Decision 输出格式 Prompt — 🟡 信息不足

**实际** ([subagent-decision.md](file:///Users/moss/Projects/CyberGroupmate/system-prompts/subagent-decision.md)):

| 缺失项 | 说明 |
|--------|------|
| ❌ 无 persona | LLM 不知道自己是什么角色，不知道该以什么标准做决策 |
| ❌ 无粘性级别 | 不知道当前群是 CORE/FAMILIAR/ACQUAINTANCE/STRANGER |
| ❌ 无 FAST_PATH_AUTH 决策选项 | JSON 示例只有 REPLY/IGNORE/DEFER，缺少 FAST_PATH_AUTH |
| ❌ 无 `contentDirection` 指导 | spec 要求主 Agent 给出明确的内容方向 |
| ❌ 无 toneGuidance 指导 | spec 要求主 Agent 给出语气约束 |
| ⚠️ 模板与 ATTENTION 分离 | spec 说 ➍ 嵌入在 ➌ 中，但实际是单独的 DECISION 模板被独立 [renderPrompt](file:///Users/moss/Projects/CyberGroupmate/src/main-agent/prompt-renderer.ts#104-115) 调用 |

**代码问题** ([main.ts L512](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#L512)):
```typescript
const decisionPrompt = renderPrompt("DECISION", promptVars);
```
只使用了 DECISION 模板，没有将 ATTENTION 模板的上下文也一并注入。LLM 收到的 user message 是 DECISION 模板（包含话题摘要 + 消息），但 system message 只有一句话。

---

### ➎ CodeActExecutor 任务注入 Prompt — 🔴 严重不足

**subagent.md §12.2 spec**:
```
[User — 任务注入]
═══ 回复任务 {{taskId}} ═══
群组: {{chatTitle}}
目标消息: [{{timestamp}}] {{senderName}}: {{text}}
话题摘要: {{contextSnapshot.topicSummary}}
相关人物: {{contextSnapshot.personContext}}

## 主 Agent 指令
内容方向: {{contentDirection}}
语气: {{toneGuidance}}
最大长度: {{maxLength}} 字符

## 约束
- 你是 {{persona.name}}，在群里像普通人一样说话
- 按照上面的内容方向和语气生成回复
- 使用 ctx.tg.sendText() 发送
```

**实际** ([subagent-execution.md](file:///Users/moss/Projects/CyberGroupmate/system-prompts/subagent-execution.md)):
```
你是群组 {{chatId}} 的 CodeAct 执行器。

## 执行任务
任务 ID: {{taskId}}
回复模式: {{replyMode}}

## 决策
{{decisions}}

## 上下文
{{context}}

请使用提供的工具函数完成回复任务。
```

| 缺失项 | 严重度 |
|--------|--------|
| ❌ **无 persona 注入** — 不知道自己是谁，不知道该用什么语气说话 | 🔴 |
| ❌ **无目标消息原文** — 不知道在回复什么 | 🔴 |
| ❌ **无 contentDirection** — 不知道主 Agent 要求回复什么方向 | 🔴 |
| ❌ **无 toneGuidance** — 不知道该用什么语气 | 🟡 |
| ❌ **无 personContext** — 不知道对话中的人物是谁 | 🟡 |
| ❌ **无 API 类型定义** — 不知道有哪些代码 API 可用 | 🔴 |
| ❌ **无 CodeAct 环境说明** — 不知道代码怎么执行、ctx 是什么 | 🔴 |
| ❌ **无 `chatTitle`** — 只有 chatId 数字，不知道群名 | 🟡 |

> [!CAUTION]
> CodeActExecutor 的 prompt 是整个系统中最关键的执行点，但当前只有 14 行极度精简的模板。Subagent LLM 完全不知道自己是谁、要用什么语气说话、要回复什么内容、有什么 API 可用。

**代码问题** ([code-act-executor.ts L208-216](file:///Users/moss/Projects/CyberGroupmate/src/subagent/code-act-executor.ts#L208-L216)):
```typescript
const executionPrompt = renderPrompt("EXECUTION", {
    chatId: this.chatId,
    taskId: task.taskId,
    replyMode: task.replyMode,
    decisions: task.decisions.map(d =>
        `- [${d.action}] ${d.reason ?? ""} (confidence: ${d.confidence})`
    ).join("\n"),
    context: JSON.stringify(task.contextSnapshot.topicDigests, null, 2),
});
```
- `decisions` 只传了 action/reason/confidence，丢失了 `contentDirection`
- `context` 只传了 `topicDigests`，丢失了 `contextSnapshot` 中的其他字段（topicSummary, recentMessages, personContext, toneGuidance, contentDirection）

---

### ➏ FastPath 系统 Prompt — 🔴 未使用 LLM

**subagent.md §12.2 spec**: FastPath 应使用 mid-tier LLM 生成回复。

**实际** ([fast-path-handler.ts L218-228](file:///Users/moss/Projects/CyberGroupmate/src/subagent/fast-path-handler.ts#L218-L228)):
```typescript
private generateReply(event: FastPathEvent, auth: FastPathConfig): string {
    for (const action of auth.preauthorizedActions) {
        if (event.text.toLowerCase().includes(action.toLowerCase())) {
            return `[FastPath:${auth.tonePreset}] ${action}`;
        }
    }
    return `[FastPath:${auth.tonePreset}] Acknowledged`;
}
```

| 缺失项 | 说明 |
|--------|------|
| ❌ **完全没有 LLM 调用** | 使用硬编码的字符串拼接模板替代 |
| ❌ **无 persona 注入** | — |
| ❌ **无 preauthorizedActions 约束 prompt** | — |
| ❌ **无 blockedActions 约束 prompt** | — |
| ❌ **[subagent-fast-path.md](file:///Users/moss/Projects/CyberGroupmate/system-prompts/subagent-fast-path.md) 模板存在但从未被使用** | 模板文件存在，代码中无引用 |

---

### ➐ Callback 结果注入 Prompt — ⚠️ 注入路径缺失

**subagent.md §12.2 spec**: Callback 结果应作为 user message 注入到主 Agent session。

**实际**: 
- [subagent-callback.md](file:///Users/moss/Projects/CyberGroupmate/system-prompts/subagent-callback.md) 模板存在但**从未被引用**（[prompt-renderer.ts](file:///Users/moss/Projects/CyberGroupmate/src/main-agent/prompt-renderer.ts) 中注册了 CALLBACK 类型，但代码中没有任何地方调用 [renderPrompt("CALLBACK", ...)](file:///Users/moss/Projects/CyberGroupmate/src/main-agent/prompt-renderer.ts#104-115)）
- [main-agent-loop.ts L152-168](file:///Users/moss/Projects/CyberGroupmate/src/main-agent/main-agent-loop.ts#L152-L168) — Phase 1 drain callbacks 只做 `recordDecision()` + `unblock()`，不注入任何内容到 LLM session
- 主 Agent 是无状态调用（前述 Issue #4），所以即使注入了也没有 session 可以注入到

---

## 二、API 暴露审计

### 1. Dynamic API Surface（分层 API 视野）— 🔴 完全未实现

**subagent.md + Implementation Plan §1.3 spec**:

| 角色 | 应可用的 API | 应禁止的 API |
|------|------------|-------------|
| **Main Agent** | 除 `telegram.sendMessage` 外的全部 | `telegram.sendMessage` |
| **Subagent** | `telegram.sendMessage` + `memory.lookup`(scope=本群) + 框架内部 API + 专属 skills | 全局 memory、跨群操作 |

**实际** ([capability-registry.ts](file:///Users/moss/Projects/CyberGroupmate/src/sandbox/capability-registry.ts)):
- 只有 **一套全局 capability registry**，安装到全局 `sandbox`
- **没有 per-role 的 API 过滤**（Main Agent 和 Subagent 看到完全相同的 API）
- 所有 API（telegram.sendText, memory.recall, actions.*, skills.*）都暴露给所有调用者
- 没有 `chatId` scope 限制（Subagent 可以访问任意群的 memory）

### 2. API 类型定义未注入 LLM Session — 🔴

**spec**: 类型定义（[.d.ts](file:///Users/moss/Projects/CyberGroupmate/src/scenes/memory.d.ts)）应注入到 Agent 的 LLM session 中，让 LLM 知道有哪些 API 可用。

**实际**:
- 旧架构 ([system-prompt.md](file:///Users/moss/Projects/CyberGroupmate/workspace/agent-docs/system-prompt.md) L44-73) 有 API 概览描述
- **但这个 system-prompt.md 在新的 Subagent 架构中从未被加载**（[loadSystemPrompt()](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#99-116) 定义于 main.ts L102 但从未被调用）
- CodeActExecutor 的 session 没有注入任何 API 类型定义
- Subagent LLM 完全不知道 `ctx.tg`、`memory`、`actions`、`skills` 等 API 的存在

**类型定义文件**存在但未使用:
- [telegram.d.ts](file:///Users/moss/Projects/CyberGroupmate/src/scenes/telegram.d.ts) — 82 行完整的 TelegramClient 类型
- [memory.d.ts](file:///Users/moss/Projects/CyberGroupmate/src/scenes/memory.d.ts) — 254 行完整的 MemoryStore 类型
- [runtime.d.ts](file:///Users/moss/Projects/CyberGroupmate/src/scenes/shared/runtime.d.ts) — 24 行 runtime API 类型
- [actions.d.ts](file:///Users/moss/Projects/CyberGroupmate/src/scenes/shared/actions.d.ts) — actions API 类型
- [skills.d.ts](file:///Users/moss/Projects/CyberGroupmate/src/scenes/shared/skills.d.ts) — skills API 类型

这些文件是设计用来注入到 LLM 上下文中的（"类型定义本身就是最好的文档"），但当前整个注入管线断裂。

### 3. SceneManager 未被新架构使用 — ⚠️

`SceneManager` 在 [main.ts](file:///Users/moss/Projects/CyberGroupmate/src/main.ts) L183 被初始化，`registerBuiltinScenes(sceneManager)` 被调用，但 `sceneManager` 从未被传递给 [CodeActExecutor](file:///Users/moss/Projects/CyberGroupmate/src/subagent/code-act-executor.ts#55-389) 或 prompt 渲染流程。它的 `getTypeDefs()` 方法从未被调用。

---

## 三、总结

### Prompt 问题优先级

| # | 注入点 | 核心问题 | 严重度 |
|---|--------|---------|--------|
| ➋ | Main Agent System Prompt | 只有一句话，无角色设定/规则/全局状态 | 🔴 |
| ➎ | CodeAct Execution Prompt | 无 persona、无 API 定义、无目标消息、无内容方向 | 🔴 |
| ➏ | FastPath Reply | 未使用 LLM，硬编码模板回复 | 🔴 |
| ➌ | Attend Context Prompt | 缺少消息原文、粘性信息、FastPath 历史 | 🟡 |
| ➍ | Decision Output Prompt | 缺少 persona、粘性、FastPath 选项 | 🟡 |
| ➐ | Callback Injection | 模板存在但注入路径断裂 | 🟡 |
| ➊ | Triage Prompt | 旧 Pipeline 遗留，功能正常但架构位置错误 | ⚠️ |

### API 暴露问题优先级

| # | 问题 | 严重度 |
|---|------|--------|
| 1 | API 类型定义未注入 CodeAct session — LLM 不知道有什么 API 可用 | 🔴 |
| 2 | 无分层 API 视野 — Main 和 Sub 看到完全相同的 API | 🔴 |
| 3 | 无 chatId scope — Subagent 可跨群访问 memory | 🟡 |
| 4 | SceneManager 初始化了但从未被使用 | ⚠️ |

### 根本原因分析

所有 prompt 问题可以归结为一个共同的根因：

> **旧架构（Phase 1-5）中的 [system-prompt.md](file:///Users/moss/Projects/CyberGroupmate/workspace/agent-docs/system-prompt.md) 包含完整的角色设定、API 说明和行为规则，由 [loadSystemPrompt()](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#99-116) 加载并注入到每个 CodeAct session。**
> **新架构（Phase 6C Subagent）完全绕过了这条路径——[loadSystemPrompt()](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#99-116) 从未被调用——但没有在新的 prompt 模板中补充这些必要信息。**

相当于旧架构有一个"基础 system prompt"兜底，新架构把这个兜底丢掉了，但新的 5 个 prompt 模板都假设 LLM 已经知道自己是谁、有什么 API——实际上它什么都不知道。
