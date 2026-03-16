# CyberGroupmate 实现 vs 文档审计报告（修订版）

> **审计时间**: 2026-03-16  
> **入口点**: [main.ts](file:///Users/moss/Projects/CyberGroupmate/src/main.ts)  
> **对照文档（优先级从高到低）**: 当前代码 → [subagent.md](file:///Users/moss/Projects/CyberGroupmate/docs/subagent.md) → [memory.md](file:///Users/moss/Projects/CyberGroupmate/docs/memory.md) → [Implementation_Plan.md](file:///Users/moss/Projects/CyberGroupmate/docs/Implementation_Plan.md)  
> **修正**: 本报告修正了上一版审计（2026-03-15 [docs/gap_audit_report.md](file:///Users/moss/Projects/CyberGroupmate/docs/gap_audit_report.md)）中的多处错误

> [!IMPORTANT]
> 上一版审计存在 **6 项错误判定**：多个"缺失"项实际已实现，多个"残留"文件实际已删除。详见 §8。

---

## 标注体系

- 🔴 **缺失** — 文档描述但未实现
- 🟡 **差异** — 已实现但与文档描述不一致
- 🟢 **冗余/残留** — 代码中存在但文档未覆盖或已过时
- ✅ **一致** — 实现与文档匹配

---

## 1. 已实现且一致的核心功能 ✅

| 组件 | 文档来源 | 实现位置 |
|------|---------|---------|
| 主 Agent 串行注意力循环 (7 阶段) | subagent.md §4.5 | [main-agent-loop.ts](file:///Users/moss/Projects/CyberGroupmate/src/main-agent/main-agent-loop.ts) |
| Q1: NotificationCenter | subagent.md §2.1 | [notification-center.ts](file:///Users/moss/Projects/CyberGroupmate/src/event/notification-center.ts) |
| Q3: DynamicAttentionQueue | subagent.md §4.3 | [attention-queue.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/attention-queue.ts) |
| Q5: CallbackQueue | subagent.md §2.2 | [callback-queue.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/callback-queue.ts) |
| SubagentManager (per-group) | subagent.md §3.0 | [subagent-manager.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/subagent-manager.ts) |
| GroupSubagent (Observer+TopicRegistry+RecordingPipeline) | subagent.md §3 | [group-subagent.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/group-subagent.ts) |
| Observer (per-group) | subagent.md §3.1 | [observer.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/observer.ts) |
| CodeActExecutor (per-group) | subagent.md §3.2 | [code-act-executor.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/code-act-executor.ts) |
| FastPathHandler | subagent.md §3.3 | [fast-path-handler.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/fast-path-handler.ts) |
| GroupStickiness 四级亲密度 | subagent.md §8 | [stickiness.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/stickiness.ts) |
| Cosine Decay L0-L3 + forceMinDepth | subagent.md §7 | [cosine-decay.ts](file:///Users/moss/Projects/CyberGroupmate/src/main-agent/cosine-decay.ts) |
| GlobalState + JSON 持久化 | subagent.md §4.4 | [global-state.ts](file:///Users/moss/Projects/CyberGroupmate/src/main-agent/global-state.ts) |
| MessageLogWriter 实时落盘 | subagent.md §1.1 | [message-log-writer.ts](file:///Users/moss/Projects/CyberGroupmate/src/event/message-log-writer.ts) |
| SandboxPool 多实例 | subagent.md §3.2 | [sandbox-pool.ts](file:///Users/moss/Projects/CyberGroupmate/src/sandbox/sandbox-pool.ts) |
| Prompt 模板系统 (➊-➐) | subagent.md §12 | `system-prompts/subagent-*.md` (7 个文件) |
| 主 Agent 系统 Prompt 含 GlobalState/TaskList/决策记录注入 | subagent.md §12.2 ➋ | [main.ts L510-540](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#L510-540) |
| TaskList Skill host call 桥接 | subagent.md §4.4 | [main.ts L179-185](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#L179-185) via `buildTaskListHostCalls()` |
| Cosine Decay alert 强制提升 (forceMinDepth) | subagent.md §7 | [main.ts L421-425](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#L421-425) + [cosine-decay.ts L67-69](file:///Users/moss/Projects/CyberGroupmate/src/main-agent/cosine-decay.ts#L67-69) |
| Observer [flushBuffer()](file:///Users/moss/Projects/CyberGroupmate/src/subagent/observer.ts#218-229) + [getMessageSnapshot()](file:///Users/moss/Projects/CyberGroupmate/src/subagent/observer.ts#230-247) | subagent.md §3.1 | [observer.ts L224-246](file:///Users/moss/Projects/CyberGroupmate/src/subagent/observer.ts#L224-246) |
| RecordingPipeline (per-group, 内嵌到 GroupSubagent) | subagent.md §3.1 | [group-subagent.ts L92-134](file:///Users/moss/Projects/CyberGroupmate/src/subagent/group-subagent.ts#L92-134) |
| Memory V2 三层记忆模型 (recall/browseHistory/reflect) | memory.md §1-5 | [memory-v2.ts](file:///Users/moss/Projects/CyberGroupmate/src/memory-v2/memory-v2.ts) (74KB) |
| Reflection 定时触发 (冷场/最大间隔/作息) | memory.md §3.3 | [main.ts L330-404](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#L330-404) |
| Reflection 引擎 (LLM + 情感合并 + 邓巴裁剪) | memory.md §3.3 | [reflection.ts](file:///Users/moss/Projects/CyberGroupmate/src/memory-v2/reflection.ts) (42KB) |
| Embedding 双模式 (FNV-1a + OpenAI API) | memory.md §4.1 | [embedding.ts](file:///Users/moss/Projects/CyberGroupmate/src/memory-v2/embedding.ts) |
| ContextManager (token budget + 话题保护) | memory.md §2 | [context-manager.ts](file:///Users/moss/Projects/CyberGroupmate/src/memory-v2/context-manager.ts) (16KB) |

---

## 2. 缺失功能 🔴

### 2.1 智能 Compaction 未集成到 CodeActExecutor

> **文档** (memory.md §2): 短期记忆使用 token 预算 + 话题连贯性保护的 Compaction  
> **现状**: [context-manager.ts](file:///Users/moss/Projects/CyberGroupmate/src/memory-v2/context-manager.ts) 已实现完整的 Compaction 逻辑（16KB），但 **未被 CodeActExecutor 的 session 管理调用**。CodeActExecutor 使用自己的简化 session compact 逻辑（基于消息数量而非 token 预算），没有话题连贯性保护。

---

### 2.2 GroupContextPackage 字段简化

> **文档** (subagent.md §4.1): 应包含 `chatTitle`、`rawMessages`、`newMessagesSinceLastAttend`、`messageSummary`、`activePersons`、`playbook`、`lastCallbacks`、`pendingCodeActTasks`、`fastPathEnabled`、`fastPathHistory`、`stickiness`  
> **现状**: [types.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/types.ts) 中的 `GroupContextPackage` 类型简化了大量字段。缺失的关键字段：
> - `chatTitle`、`rawMessages`、`newMessagesSinceLastAttend`
> - `messageSummary`、`activePersons: PersonGroupProfile[]`
> - `playbook: GroupPlaybook`
> - `lastCallbacks`、`pendingCodeActTasks`、`fastPathEnabled/History`、`stickiness`

> [!NOTE]
> 部分信息通过 `buildAttentionVariables()` 以字符串形式注入 prompt（如 FastPath 历史、消息原文），但不是结构化的 GroupContextPackage 字段。功能上**部分等效**但类型安全性不足。

---

### 2.3 GroupStickiness 大量参数缺失

> **文档** (subagent.md §8): `GroupStickiness` 应包含 `replyFrequency`、`initiativeLevel`、`maxInterventionsPerHour`、`cooldownAfterIntervention`、`overactiveThreshold`、`overactiveStrategy`、`feedbackHistory`  
> **现状**: [stickiness.ts](file:///Users/moss/Projects/CyberGroupmate/src/subagent/stickiness.ts) 只实现了基本的四级 `level`、`priorityMultiplier`、`depthCyclePeriod`、`fastPathEligible`。精细调控参数全部缺失。

---

### 2.4 Playbook System

> **文档** (Implementation_Plan.md Phase 7.1): SOTA 定期分析生成 GroupPlaybook，注入弱模型上下文  
> **现状**: 完全未实现，标记为 📝 规划中。无代码、无类型定义。

---

### 2.5 Skill Auto-Generation / CoT Template Distillation / Cost Control / Degradation Strategy

> **文档** (Implementation_Plan.md Phase 7.2-7.5)  
> **现状**: Phase 7 全部 📝 规划中，未开始实现。

---

### 2.6 CodeActReplyTask 字段不完整

> **文档** (subagent.md §2.2 B1): 应包含 `targetMessageIds`、`topicId`、`contextSnapshot: { topicSummary, recentMessages, personContext, toneGuidance, contentDirection }`、`replyStrategy`、`maxResponseTime`  
> **现状**: `CodeActReplyTask` 类型缺少 `targetMessageIds`、`replyStrategy`、`maxResponseTime`。`contextSnapshot` 的额外字段通过 `as any` 在 main.ts dispatch handler 中动态注入（[main.ts L657-661](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#L657-661)），类型不安全。

---

### 2.7 Session Compaction 模块位置不清

> **文档** (Implementation_Plan.md §2.8 + memory.md §3.5): Compaction 应提炼 core_facts、更新 person_profiles，不再创建话题节点  
> **现状**: 旧的 `src/event/compaction.ts` 已被删除。CodeActExecutor 内有简化的 session compact 逻辑，但不确定是否对接了 memory V2 的 core_facts 写入。

---

### 2.8 `sqlite-vec` 原生向量搜索

> **文档** (memory.md §4.1): 使用 `sqlite-vec` 扩展进行原生向量搜索  
> **现状**: [embedding.ts](file:///Users/moss/Projects/CyberGroupmate/src/memory-v2/embedding.ts) 实现了纯 JS FNV-1a fallback。`sqlite-vec` 原生加速标记为可选（M4.7），当前使用暴力搜索，对 <10K 条记录足够，但非文档描述的 `sqlite-vec` 原生路径。

---

## 3. 实现与描述差异 🟡

### 3.1 消息分发方式：NC.onPush 内联 vs GroupDispatcher

> **文档** (subagent.md §2.1): "GroupDispatcher 按 chatId 分发到各 Subagent"  
> **现状**: 无 `GroupDispatcher` 文件。消息分发通过 `nc.onPush()` 内联实现（[main.ts L277-303](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#L277-303)）。**功能等效。**

---

### 3.2 FastPath 触发点

> **文档** (subagent.md §3.3): Observer 检测到触发消息后调用 FastPath  
> **现状**: FastPath 触发在 NC.onPush hook（[main.ts L290-302](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#L290-302)）中实现，不在 Observer 内部。**功能等效。**

---

### 3.3 Q4 ExecutionQueue 内化

> **文档** (subagent.md §2.1): "Q4: 群组 Execution Queue" 作为显式队列  
> **现状**: 无独立的 `execution-queue.ts` 文件。CodeActExecutor 内部管理自己的 `taskQueue`。**功能等效但缺少正式抽象。**

---

### 3.4 AttentionQueueEntry 字段名差异

> **文档**: `engagementScore`、`urgentSignals`、`pendingMessageCount`、`snapshotTimestamp`、`attendCycle`  
> **现状** ([group-subagent.ts L179-197](file:///Users/moss/Projects/CyberGroupmate/src/subagent/group-subagent.ts#L179-197)): 实际上大部分字段**已补齐**：
> - `engagementScore` ✅ (L194)
> - `urgentSignals` ✅ (L195)
> - `snapshotTimestamp` ✅ (L196)
> - `pendingMessageCount` → `newMessageCount` 🟡 名称不同
> - `attendCycle` → `attendCount` 🟡 名称不同

---

### 3.5 SubagentCallback 字段名差异

> **文档**: `source: 'CODE_ACT' | 'FAST_PATH'`、`type: 'COMPLETED' | 'FAILED' | 'TIMEOUT'`  
> **现状**: 实现中重命名为 `executionType`、`status`（新增 `SKIPPED`），`result` 被拍平。**功能等效，命名差异。**

---

### 3.6 Decision 输出格式：`type` → `action`

> **文档** (subagent.md §12.2 ➍): `type: "CODEACT_REPLY" | "IGNORE" | "FAST_PATH_AUTH"`  
> **现状**: 使用 `action: "REPLY" | "IGNORE" | "DEFER" | "FAST_PATH_AUTH" | "OBSERVE"`。**代码新增了 `DEFER` 和 `OBSERVE` 类型。**

---

### 3.7 stickiness 字段名：`familiarity` → `level`

> **文档** (subagent.md §8): `GroupStickiness.familiarity`  
> **现状**: 使用 `GroupStickiness.level`

---

### 3.8 message_log 写入时机

> **文档** (memory.md §5.2): "消息写入时机：Recording Pipeline 在每次 flush 时批量写入"  
> **现状**: `MessageLogWriter` 通过 `nc.onPush` hook 实时写入（[main.ts L274](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#L274)）。

> [!TIP]
> **实现优于文档**：实时落盘比批量写入更可靠，与 subagent.md §1.1 "同步落盘到 message_log" 的要求一致。memory.md 需更新。

---

## 4. Implementation_Plan.md 特有问题

### 4.1 架构图过时

[Implementation_Plan.md §1.1](file:///Users/moss/Projects/CyberGroupmate/docs/Implementation_Plan.md#L112-179) 的 mermaid 架构图仍展示 Phase 6A 的 FastRouter → ReplyPipeline 流程。**与当前 Subagent 架构不匹配**，需要更新为 NC → Observer → Q3 → MainAgentLoop → CodeActExecutor/FastPath 流程。

---

### 4.2 Phase 6 任务标记完成但组件已被替换

| Task | 标记状态 | 实际情况 |
|------|---------|---------|
| 6.1 Air-Reading Engine (FastRouter) | ✅ 完成 | 文件已删除，功能被 Observer+MainAgentLoop 替代 |
| 6.1.1 Engaged Topic Handler | ✅ 完成 | 文件已删除，功能被 Subagent 快速路径替代 |
| 6.3 Reply Pipeline Framework | ✅ 完成 | 文件已删除，功能被 CodeActExecutor 替代 |
| 6.7 Dry-Run System | ✅ 完成 | 文件已删除 |
| 6.8 Model Router | ✅ 完成 | 文件已删除 |

> [!WARNING]
> 这些任务仍标记为 ✅ 完成，但其代码已不存在于项目中。建议将它们重新标注为 "✅→🔄 被 6C 架构替代" 并说明替代关系。

---

### 4.3 目录结构描述过时

Implementation_Plan.md §7 目录结构列出了 `fast-router.ts`、`engaged-topic-handler.ts`、`reply-pipeline.ts`、`context-assembler.ts`、`model-router.ts`、`dry-run.ts`，这些文件均已不存在。需要更新。同时缺少对 `src/subagent/` 和 `src/main-agent/` 目录的描述（虽然在 Task 列表中有提及），以及 `src/event/message-log-writer.ts`。

---

## 5. 冗余/残留 🟢

> [!NOTE]
> 上一版审计列出了 `fast-router.ts`、`reply-pipeline.ts`、`context-assembler.ts`、`model-router.ts`、`engaged-topic-handler.ts`、`execution-queue.ts`、`group-dispatcher.ts`、`compaction.ts` 作为残留文件。经核实，**这些文件已全部从项目中删除**。

### 5.1 `pipeline/` 目录中的未使用导出

`src/pipeline/index.ts` 可能仍导出已被替代的 Phase 6A 类型/组件。需要检查 barrel export 是否干净。

### 5.2 FeedbackLoop 的全局 TopicRegistry

main.ts L228 创建了一个仅供 FeedbackLoop 使用的 `globalTopicRegistryForFeedback` TopicRegistry 实例。这个实例**不与任何 per-group TopicRegistry 同步**，可能导致 FeedbackLoop 的 topic 追踪失效。

### 5.3 `hostRL` / `promptUser` 保留

main.ts L208-216 的 readline 交互式输入能力仍然需要（sandbox input_request 事件使用），**非残留**。

---

## 6. Memory V2 详细对照

| 模块 | memory.md 章节 | 状态 | 说明 |
|------|---------------|------|------|
| 三层记忆模型概览 | §1 | ✅ | |
| 短期 Compaction (ContextManager) | §2 | 🟡 | 已实现但未集成到 CodeActExecutor |
| Episodic + Social Memory | §3 | ✅ | topics/person_*/interactions 表 |
| 情感记忆渐进合并 | §3.2 | ✅ | reflection.ts |
| Reflection Skill | §3.3 | ✅ | reflection.ts + main.ts 定时触发 |
| SQLite 7 张表 + FTS5 | §3.4 | ✅ | |
| Pipeline↔TopicNode 双层架构 | §3.6 | ✅ | |
| `recall()` 统一检索 | §4 | ✅ | 混合检索已实现 |
| `browseHistory()` 消息档案 | §5 | ✅ | 意图解析 + 深度阅读 |
| `js-tiktoken` BPE 精确 token | §2.3 | 🔴 | context-manager.ts 使用 CJK 感知估算（非 BPE） |
| `sqlite-vec` 原生向量搜索 | §4.1 | 🟡 | 使用纯 JS 暴力搜索 fallback |
| message_log 写入时机 | §5.2 | 🟡 | 实时写入（优于文档描述的批量写入） |

---

## 7. 优先级建议

### 高优先级

1. **🔴 智能 Compaction 集成** (§2.1) — CodeActExecutor session 缺少话题连贯性保护，可能导致 agent 在长对话中"断片"
2. **🟡 GroupStickiness 精细参数** (§2.3) — `replyFrequency`、`maxInterventionsPerHour` 等调控参数缺失，影响多群组场景下的行为调控
3. **🟡 CodeActReplyTask 类型安全** (§2.6) — `as any` 注入字段缺少类型定义，存在运行时错误风险

### 中优先级

4. **🟡 GroupContextPackage 字段补齐** (§2.2) — 部分信息以字符串注入 prompt 但缺少结构化类型
5. **🟡 文档同步更新** (§4.1-4.3) — Implementation_Plan.md 架构图、目录结构、Phase 6 任务状态需要与当前 Subagent 架构对齐
6. **🟢 FeedbackLoop 的 TopicRegistry 同步** (§5.2) — 全局实例与 per-group 实例不同步

### 低优先级

7. **🟡 SubagentCallback/AttentionQueueEntry 字段命名** (§3.4-3.5) — 功能等效但名称与文档不一致
8. **🔴 Playbook System** (§2.4) — Phase 7 规划中，非当前阻塞项
9. **🟡 `js-tiktoken` BPE 精确 token** (§6) — 当前 CJK 感知估算可用，低优先级优化

---

## 8. 上一版审计错误修正

| 上一版条目 | 标记 | 实际情况 | 修正 |
|-----------|------|---------|------|
| §2.11 TaskList Skill host call 未桥接 | 🔴 缺失 | ✅ 已实现 ([main.ts L179-185](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#L179-185)) | `createTaskListSkill()` + `buildTaskListHostCalls()` 在 sandbox host call handler default case 中注册 |
| §2.13 主 Agent 系统 prompt 缺少 GlobalState/TaskList 注入 | 🔴 缺失 | ✅ 已实现 ([main.ts L510-540](file:///Users/moss/Projects/CyberGroupmate/src/main.ts#L510-540)) | 包含 `globalState.getAttentionSummary()`、`recentDecisionsText`、`activeTasksText` |
| §2.2 Observer 缺少 `flushBuffer()` / `getMessageSnapshot()` | 🔴 缺失 | ✅ 已实现 ([observer.ts L224-246](file:///Users/moss/Projects/CyberGroupmate/src/subagent/observer.ts#L224-246)) | 两个方法均存在，`flushBuffer()` 为占位实现（RecordingPipeline 独立管理 flush），`getMessageSnapshot()` 返回最近 N 条消息 |
| §3.4 Cosine Decay 缺少 urgentSignals/alert 强制提升 | 🟡 差异 | ✅ 已实现 | `calculateDepth()` 支持 `DepthOptions.forceMinDepth`，main.ts attend handler 传入 `forceMinDepth: 2` for alert |
| §4.1 FastRouter/ReplyPipeline 等为残留文件 | 🟢 残留 | 已删除 | `fast-router.ts`、`reply-pipeline.ts`、`context-assembler.ts`、`model-router.ts`、`engaged-topic-handler.ts`、`dry-run.ts` 均已从项目中删除 |
| §4.2-4.3 GroupDispatcher / ExecutionQueue 残留 | 🟢 残留 | 已删除 | 两个文件均已从项目中删除 |

---

## 9. 总结

| 类别 | 数量 |
|------|------|
| ✅ 一致 | **~28 项**核心功能 |
| 🔴 缺失 | **8 项**（智能 Compaction 集成、GroupContextPackage 完整字段、Stickiness 精细参数、Playbook、Phase 7 全部、CodeActReplyTask 类型安全、Session Compaction 模块、sqlite-vec） |
| 🟡 差异 | **8 项**（字段命名、message_log 写入时机、分发方式、触发点、Decision 格式等） |
| 🟢 冗余/残留 | **2 项**（FeedbackLoop 全局 TopicRegistry、pipeline index 导出） |

**总体评估**: Subagent 架构的骨架已**完整实现并工作**。与上次审计相比，多个被标记为缺失的功能（TaskList host call、GlobalState prompt 注入、Cosine Decay alert 提升）实际已实现。主要的真实 gap 在于：

1. **智能 Compaction 未集成**到 CodeActExecutor，是影响用户体验的最大短板
2. **类型安全性不足**（`as any` 注入 contextSnapshot 字段）
3. **GroupStickiness 精细调控参数缺失**，影响多群组场景行为
4. **三份文档与代码均存在同步滞后**，尤其是 Implementation_Plan.md 的架构图和目录结构描述
