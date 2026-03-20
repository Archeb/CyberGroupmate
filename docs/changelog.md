# Changelog

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
