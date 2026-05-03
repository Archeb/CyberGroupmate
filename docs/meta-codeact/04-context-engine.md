# Phase 4: Meta ContextEngine Providers + Session Digest

## 目标

为 Meta-CodeAct session 构建专用 ContextEngine providers，管理系统指令、AttentionSet、备忘录、历史摘要的组装和缓存策略。

## 新建文件

### `src/context-engine/providers/meta-providers.ts`

注册 5 个 provider，供 Meta-CodeAct session 使用：

```typescript
import { SectionProvider } from '../types.js';

// 所有 provider 遵循 ContextEngine 框架的 cache + history 策略
// cache: static（不变） / snapshot（每次快照） / volatile（每次重算）
// history: persistent（保留在历史中） / ephemeral（仅当次可见） / delta-only（仅新增部分）

export function getMetaProviders(): SectionProvider[] {
  return [
    metaSystemInstructions,
    metaApiReference,
    metaSessionDigest,
    metaAttentionSet,
    metaActiveMemos,
  ];
}
```

#### `meta.systemInstructions` — 系统指令

| 属性 | 值 |
|:-----|:---|
| cache | `static`（启动后不变） |
| history | `ephemeral`（不保留到 session 历史） |

内容：从 `system-prompts/meta-agent/meta-system.md` 模板渲染。包含：
- 角色定义："你是全局编排者，俯瞰所有群组，通过代码调用 API 进行调度"
- 行为规则：不直接发送消息，只通过 dispatch.taskToGroup 委派
- Session Digest 指令：要求在最后一轮 thinking 中以 `[SESSION_DIGEST]` 标记写自我总结

#### `meta.apiReference` — API 文档

| 属性 | 值 |
|:-----|:---|
| cache | `static` |
| history | `ephemeral` |

内容：6 个 Meta API 的签名和用法说明。类似现有 `loadApiTypeDefs()` 的模式，但面向 Meta Agent。

#### `meta.sessionDigest` — 会话历史摘要

| 属性 | 值 |
|:-----|:---|
| cache | `snapshot` |
| history | `persistent`（跨 session 保留） |

内容：从 `globalState.getSessionDigests()` 获取最近 N 条（默认 10），拼接为：
```
## 近期会话记录
[2026-05-01 12:00] 上一轮我决定派发任务给群 A 讨论团建，正在等 B 群回复...
[2026-05-01 11:50] 收到群 C 的 @mention，已派发回复任务...
```

#### `meta.attentionSet` — 当前注意力集

| 属性 | 值 |
|:-----|:---|
| cache | `volatile`（每次重算） |
| history | `ephemeral`（不保留） |

内容：将 `AttentionSet` 渲染为结构化文本，例如：
```
## 🔴 紧急
- [DM] telegram:123456 — 用户直接找你
  最近消息: "在吗？帮我查一下..."

## 🟡 到期
- [CALLBACK] 群A 任务 task_xxx 已完成: 发送了 2 条消息

## 🟢 信号 (pressure 排序)
- [TOPIC] telegram:group1 — "周末团建" (pressure=42.5)
  参与者: Alice(tier1), Bob(tier2), 3条消息
- [TOPIC] telegram:group2 — "技术讨论" (pressure=18.2)
  参与者: Charlie(tier3), 8条消息
```

渲染模板位于 `system-prompts/meta-agent/meta-attention.md`。

#### `meta.activeMemos` — 备忘录

| 属性 | 值 |
|:-----|:---|
| cache | `snapshot` |
| history | `ephemeral` |

内容：从 `globalState.memoList()` 获取存活 memo，渲染为：
```
## 当前备忘录
- key1: value1 (永不过期)
- key2: value2 (过期: 2026-05-01 15:00)
```

---

## 新建文件

### `system-prompts/meta-agent/meta-system.md`

```markdown
你是 {{personaName}} 的全局编排大脑。你不直接与任何群组互动，而是通过代码调用管理 API 来调度你的下属 Agent。

## 你的能力
- `conversations.query(filters)` — 跨群检索消息和话题
- `memory.searchEntities(query, options?)` — 检索事实和人物身份
- `agents.listStatus()` — 查看所有群组的 Agent 状态
- `dispatch.taskToGroup(chatId, taskSpec)` — 向指定群组派发任务
- `memo.set/get/delete/list` — 读写跨会话备忘录
- `schedule.wakeOnCondition(condition)` — 设定唤醒条件

## 规则
1. 你**不能**直接发送消息。所有回复都通过 `dispatch.taskToGroup` 委派
2. 查询是免费的，多查少猜
3. 如果不确定要不要回复某个群，先查上下文再决定
4. 任务的 contentDirection 要具体，你的下属比你更了解群内的即时语境
5. 通过 context 字段可以把你查到的跨群信息传递给下属

## Session Digest
每次会话结束前，在你的最后一次思考中，请以 [SESSION_DIGEST] 标记写一段自我总结。
记录：你做了什么决定、为什么、还有什么在等待。
格式：[SESSION_DIGEST]你的总结[/SESSION_DIGEST]
```

### `system-prompts/meta-agent/meta-attention.md`

AttentionSet 渲染模板（Mustache）：
```markdown
{{#urgentItems}}
## 🔴 紧急
{{#items}}
- [{{source}}] {{chatId}} {{#payload.preview}}— {{payload.preview}}{{/payload.preview}}
{{/items}}
{{/urgentItems}}

{{#dueItems}}
## 🟡 到期
{{#items}}
- [{{source}}] {{chatId}} — {{payload.summary}}
{{/items}}
{{/dueItems}}

{{#signalItems}}
## 🟢 信号
{{#items}}
- [{{source}}] {{chatId}} — "{{payload.label}}" (pressure={{pressure}})
  {{payload.summary}}
{{/items}}
{{/signalItems}}
```

---

## 修改文件

### `src/main-agent/main-agent-loop.ts`

- 删除旧的 `_attendEngine`（attend ContextEngine）
- 新建 Meta ContextEngine：`new ContextEngine('meta')` + `registerAll(getMetaProviders())`

### `src/context-engine/providers/attend-providers.ts` — **删除**

被 `meta-providers.ts` 替代。

## 验证

- 各 provider 的 resolve + render 输出正确
- sessionDigest 的 persistent 策略：第二次 render 时包含上次的 digest
- attentionSet 的 ephemeral 策略：不出现在下次 session 的 historicalContent 中
- Session Digest 提取正则：[SESSION_DIGEST]...[/SESSION_DIGEST] 和 fallback
