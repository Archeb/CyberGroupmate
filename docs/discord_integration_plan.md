# Discord 集成实施计划

> **创建日期**: 2026-03-22
> **前置文档**: 风险评估 v2（brain artifact）
> **状态**: 待实施

## 实施原则

> [!CAUTION]
> **遇到不确定的情况必须立即停下来问，不允许：**
> - 自作主张实现不确定的逻辑
> - 写 `// TODO` 占位跳过
> - 用空白数据、假数据或硬编码值糊弄
> - 在不理解上下文的情况下模仿现有代码"照猫画虎"
>
> 正确做法：描述清楚"我不确定 X 应该怎么处理，因为 Y"，然后等待回复。

其他原则：
- 每个 Step 完成后必须通过对应的验证项，再进入下一步
- 修改现有文件时，优先保持向后兼容——旧的 Telegram-only 运行模式不能因为重构而中断
- 数据迁移必须可回滚

---

## 已确认架构决策速查

| 决策 | 结论 |
|:---|:---|
| chatId 格式 | `{platform}:{rawId}`，先迁移 Telegram 再接 Discord。文件名中 `:` 用 `_` 替代 |
| **userId 格式** | **同 chatId，`{platform}:{rawId}`。所有数字型 userId 必须加平台前缀，非数字（如 `agent`）保持原样** |
| Discord chatId 粒度 | channelId。每个 Channel/Thread 独立 sandbox 和 session |
| Guild ↔ Group | Guild = Group（共享 GroupModel/PersonProfile），Channel = 独立上下文 |
| core_facts.subject | **已迁移** — 数字型 subject（代表 userId）加 `telegram:` 前缀 |
| 测试策略 | 修改现有测试以适应多平台架构，不单独写 Discord 专用测试 |
| Session 路径 | `{platform}/{groupId}/{channelId}.json`（Telegram 无 channel 层） |
| Sandbox API | 保留 `ctx.tg.*` + 新增 `ctx.discord.*`，按平台注入 |
| 事件类型 | 所有 adapter 统一推送 `nc.message` |
| 媒体下载 | adapter 负责，Message 增加 `rawMessage` |
| 安全限制 | adapter 动态注册写操作白名单 |
| chatType | 只需 `private` / `group` / `channel` |
| events.jsonl | 不迁移，只写消息队列，历史数据不被使用 |
| **存储 vs 展示** | **存储层用 composite key，面向 LLM/Sandbox 展示时用 `getRawId()` 剥离前缀** |
| **Sandbox 安全检查** | **用 `ensureCompositeId(platform, rawId)` 自动补全，LLM 代码可用裸 ID** |

---

## Phase 0: Telegram 侧统一（不涉及 Discord 代码）

目标：将现有 Telegram 运行时全面切换为 composite key + 统一事件类型，验证功能不受影响。

### Step 0.1: Composite Key 工具函数

**新建** `src/core/chat-id.ts`

提供 composite key 的创建、解析、平台判断等工具函数：

```
composeChatId(platform, rawId) → "telegram:-1001234567"
parseChatId(compositeId) → { platform, rawId, groupId?, channelId? }
getPlatform(compositeId) → "telegram" | "discord"
isDiscord(compositeId) → boolean
chatIdToFileName(compositeId) → "telegram_-1001234567"  // `:` → `_` for filesystem
fileNameToChatId(fileName) → "telegram:-1001234567"     // `_` → `:` reverse
```

Discord 三段式 key `discord:{guildId}:{channelId}` 的解析也在此处处理。

**验证**:
- 单元测试覆盖：二段式（Telegram）、三段式（Discord）的创建和解析
- 边界情况：空字符串、无前缀的旧格式 chatId

---

### Step 0.2: SQLite 数据迁移脚本

**新建** 迁移脚本，为所有 `chat_id` 列值加 `telegram:` 前缀。

涉及的表：
- `message_log` — `chat_id` 列
- `topics` — `chat_id` 列
- `group_models` — `chat_id` 列
- `person_group_profiles` — `chat_id` 列
- `interactions` — `chat_id` 列

**不迁移**: `core_facts.subject` 列 — 内容可能是 userId、chatId 或自然语言主题，模糊查询不依赖精确格式。

**验证**:
- 迁移前备份 `memory.db`
- 迁移后用 SQL 查询确认所有 `chat_id` 值都有 `telegram:` 前缀
- 确认无数据丢失（迁移前后行数一致）
- 回滚测试：能恢复到迁移前状态

---

### Step 0.3: Session 文件迁移

修改 `workspace/sessions/telegram/{chatId}.json` 文件：
- 文件名中的 chatId 改为 composite key 格式，`:` 用 `_` 替代（如 `telegram_-1001234567.json`）
- JSON 内部的 `chatId` 字段同步更新为 `telegram:-1001234567`（运行时用 `:`）
- 使用 `chatIdToFileName()` / `fileNameToChatId()` 在两种格式之间转换

**验证**:
- 文件重命名后，启动应用能正确恢复 session
- `SubagentManager.restoreAll()` 正常工作

---

### Step 0.4: 修改现有测试适应多平台

修改 `tests/` 下现有测试，使其适应 composite key 格式和统一事件类型：
- 测试中的 chatId 改为 composite key 格式（如 `telegram:test-chat-1`）
- 事件类型从 `telegram.message` 改为 `nc.message`
- 确保测试逻辑不依赖特定平台的 chatId 格式
- 测试工具函数 `composeChatId` / `parseChatId` / `chatIdToFileName` 的正确性

**验证**:
- 所有现有测试通过

---

### Step 0.5: NC 事件类型统一

修改 `telegram-adapter.ts`：推送到 NC 的事件 `type` 从 `telegram.message` 改为 `nc.message`。

同步修改所有消费者的过滤条件：

| 文件 | 修改 |
|:---|:---|
| `main.ts` L391 | 去掉 `telegram.message` 分支，只保留 `nc.message` |
| `event-bridge.ts` L56 | 同上 |
| `message-log-writer.ts` L30 | 默认 `eventTypes` 改为 `["nc.message"]` |
| `nc-event.ts` L109 | 去掉 `telegram.message` 专用标准化分支 |

**验证**:
- 启动 Telegram，发消息，确认：
  - NC 事件日志中只有 `nc.message` 类型
  - 消息正常落盘到 `message_log`
  - Observer 正常接收消息
  - Dashboard WebSocket 正常收到消息
  - RecordingPipeline flush 正常
  - 话题 triage 正常
  - 主 Agent 能看到消息并做决策

---

### Step 0.6: 运行时代码全量切换 Composite Key

逐文件修改，将所有使用裸 chatId 的地方改为 composite key。

**核心路径**（按调用顺序）：
1. `telegram-adapter.ts` — `normalizeIncomingMessage()` 输出的 `chatId` 改为 `composeChatId("telegram", rawChatId)`
2. `main.ts` — 所有从 NC 事件取 chatId 的地方，已经是 composite key 了
3. `SubagentManager` — `getOrCreate(chatId)` 的 key 自然变为 composite key
4. `SandboxPool` — `acquire(chatId)` 的 key 自然变为 composite key
5. `memory` 层 — 已通过 Step 0.2 迁移完毕，运行时写入的 chatId 也是 composite key
6. `dispatch-handler.ts` — chatId 透传，无需额外修改
7. `GlobalState` — chatId 透传
8. `FeedbackLoop` — chatId 透传
9. `nc-event.ts` — `isDirectMessage` 判断从 chatId 符号推断改为从事件字段读取

**host call 安全限制**：`main.ts` 中 sandbox 的 `targetChatId !== chatId` 校验，两边都是 composite key，逻辑不变。

**验证**:
- 完整功能回归测试（同 Step 0.4 验证项）
- 确认 `memory.db` 中新写入的消息 chatId 均为 `telegram:xxx` 格式
- 确认 session 文件路径和内容中的 chatId 均为 composite key
- 确认 Dashboard 正常展示（chatTitle 不受影响，chatId 显示为 composite key）

---

### Step 0.7: `PlatformAdapter` 接口扩展

修改 `src/adapter/platform-adapter.ts`，增加方法：

```typescript
interface PlatformAdapter {
    // 现有
    start(): Promise<void>;
    stop(): Promise<void>;
    canHandle(method: string): boolean;
    handleCall(method: string, args: unknown[]): Promise<unknown>;
    // 新增
    getPlatformName(): string;
    getWriteMethods(): string[];
    downloadMedia(rawMessage: unknown, mediaRef: string): Promise<Buffer>;
}
```

修改 `TelegramAdapter` 实现新增方法。

修改 `main.ts` 中 `WRITE_METHODS` 硬编码为调用 `adapter.getWriteMethods()`。

**验证**:
- TypeScript 编译通过
- Telegram 功能不受影响

---

### Step 0.8: Message 类型扩展

修改 `pipeline/types.ts` 的 `Message` 接口，增加：

```typescript
interface Message {
    // ... 现有字段 ...
    platform?: string;
    rawMessage?: unknown;
}
```

修改 `telegram-adapter.ts` 的 `normalizeIncomingMessage()` 填充这两个字段。

**验证**:
- TypeScript 编译通过
- 现有消息处理逻辑不受影响（新字段均为 optional）

---

### Phase 0 实施记录（2026-03-22 ~ 2026-03-23）

> **分支**: `feature/discord-integration`
> **状态**: ✅ 完成

#### 新建文件

| 文件 | 说明 |
|:---|:---|
| `src/core/chat-id.ts` | Composite key 工具函数（`composeChatId`, `parseChatId`, `getRawId`, `ensureCompositeId` 等） |
| `scripts/migrate-chat-id.ts` | SQLite chat_id 迁移脚本（13,844 行，5 表） |
| `scripts/migrate-sessions.ts` | Session 文件迁移（10 文件重命名 + JSON 内 chatId 更新） |
| `scripts/migrate-user-id.ts` | SQLite user_id 迁移脚本（9,725 行，4 表） |
| `tests/chat-id.test.ts` | chat-id.ts 单元测试（28 用例） |

#### 修改文件摘要

| 文件 | 关键改动 |
|:---|:---|
| `telegram-adapter.ts` | `composeChatId("telegram", ...)` 输出 chatId 和 userId；`normalizePeerArg` 剥离前缀给 mtcute；`getWriteMethods()` 实现 |
| `platform-adapter.ts` | +`getWriteMethods()`, +`downloadMedia?()` |
| `subagent-manager.ts` | `chatIdToFileName` / `fileNameToChatId` 转换 |
| `message-log-writer.ts` | 默认 eventType → `nc.message` |
| `event-bridge.ts` | 过滤 `nc.message` |
| `main.ts` | 安全检查用 `ensureCompositeId`；动态 `getWriteMethods()`；导入 chat-id 工具 |
| `media-downloader.ts` | chatId colon 消毒（macOS HFS+ 兼容） |
| `pipeline/types.ts` | +`rawMessage` 字段 |
| `reflection.ts` | 所有 LLM 返回的 userId 写入前 `ensureCompositeId(getPlatform(chatId), userId)`；prompt 中 `getRawId()` |
| `code-act-executor.ts` | 执行任务 prompt 用 `getRawId(chatId)`；personContext userId 用 `getRawId()`；storeFact subject `ensureCompositeId` |
| `attend-handler.ts` | activePersons userId 用 `getRawId()` |
| `prompt-renderer.ts` | 所有 LLM-facing chatId 用 `getRawId()` |

#### 数据迁移统计

| 迁移项 | 范围 | 行数 |
|:---|:---|:---|
| chat_id → `telegram:` | `message_log`, `topics`, `group_models`, `person_group_profiles`, `interactions` | 13,844 |
| user_id → `telegram:` | `person_identities`, `person_group_profiles`, `message_log`, `interactions` | 9,725 |
| session 文件 | `workspace/sessions/telegram/` | 10 文件 |
| core_facts.subject | 数字型 subject 加 `telegram:` | 补充迁移 |
| person_profiles.user_id | 遗留表全量迁移 | 10+ |

#### 关键决策与 Bugfix

**BF-1: userId 也必须 composite key**

原计划只迁移 chatId。但 Telegram userId（纯数字）与 Discord userId（纯数字 snowflake）存在碰撞风险，因此 userId 也必须加平台前缀。非数字值（`agent`、角色名）不加前缀。

**BF-2: Sandbox 安全检查自动补全**

LLM 生成的代码用 `ctx.tg.sendText(682932098, text)`（裸数字），但 sandbox 绑定的 chatId 是 `telegram:682932098`。解决方案：安全检查前用 `ensureCompositeId("telegram", rawTarget)` 自动补全，而不是要求 LLM 知道 composite key 格式。

**BF-3: 存储 composite / 展示 raw 的双向转换**

核心原则：**存储层一律用 composite key**，**面向 LLM 的所有上下文一律用 `getRawId()`**。这包括：
- 执行任务 prompt 中的 `{{chatId}}`
- personContext 中的 `userId`
- 主 Agent 决策/任务列表中的 chatId
- reflection prompt 中的参与者统计

**BF-4: reflection 写回路径的 userId 归一化**

reflection LLM 看到的 userId 是裸 ID（因 prompt 中用了 `getRawId`），返回结果中的 userId 也是裸 ID。写入 `upsertPersonIdentity` / `upsertPersonGroupProfile` / `storeFact` 之前必须 `ensureCompositeId(getPlatform(chatId), userId)` — 平台信息从 reflection 的 `chatId` 参数获取，**不靠推断 ID 格式**。

**BF-5: `person_profiles` 遗留表**

`person_profiles` 是旧表，当前代码已无引用，但仍有数据。已迁移其 `user_id` 列。

#### chat-id.ts 工具函数清单

| 函数 | 用途 |
|:---|:---|
| `composeChatId(platform, ...parts)` | 创建 composite key |
| `parseChatId(compositeId)` | 解析为 `{ platform, rawId, groupId?, channelId? }` |
| `getPlatform(compositeId)` | 提取平台名 |
| `isTelegram(id)` / `isDiscord(id)` | 平台判断 |
| `chatIdToFileName(id)` / `fileNameToChatId(name)` | 文件名转换 |
| `getGroupChatId(id)` | 获取 group 级 key（Discord → guild 级） |
| `isValidCompositeChatId(id)` | 校验格式 |
| `getRawId(compositeOrRawId)` | 剥离平台前缀（用于 LLM 展示） |
| `ensureCompositeId(platform, id)` | 如无前缀则自动补全（用于安全检查/写入） |

---

### Phase 1 实施备注

> [!IMPORTANT]
> 以下是 Phase 0 实施过程中发现的、对 Phase 1 有影响的重要细节。

#### 1. Host Call 路由需要泛化

当前 `main.ts` 的 `setHostCallHandler` 中硬编码了 `telegramAdapter.canHandle(method)` 和 `ensureCompositeId("telegram", rawTarget)`。Phase 1 需要改为**按 method 前缀路由到对应 adapter**，安全检查中的平台名从 `chatId` 的 composite key 提取（`getPlatform(chatId)`）而非硬编码。

#### 2. sendSticker 特殊处理

`main.ts` 中 `telegram.sendSticker` 有一段独立的 host call 处理逻辑（读取本地文件 → 构造 buffer → 调用 `sendMedia`）。这段逻辑是 Telegram 特有的，Discord 不需要。Phase 1 routing 时需要确保 Discord 的 host call 不经过这段代码。

#### 3. `scene.ts` 硬编码 `"telegram"`

`src/sandbox/modules/scene.ts` 中 `current: "telegram"` 是硬编码的。Phase 2 Step 2.1 需要改为从 chatId 的 platform 动态传入。

#### 4. `nc-event.ts` 遗留分支

`nc-event.ts` L109-145 有一个处理旧 `telegram.message` 事件的遗留分支。这个分支只在读取旧 `events.jsonl` 数据时触发。Phase 1 不需要修改它，但如果未来清理 events.jsonl 时可以移除。

#### 5. `normalizePeerArg` 前缀剥离

`telegram-adapter.ts` 的 `normalizePeerArg` 对传入的 composite chatId 做 `parseChatId().rawId` 提取裸 ID 给 mtcute。Discord adapter 的对应函数需要类似逻辑，但 Discord 的 API 直接接受 string ID，不需要 `Number()` 转换。

#### 6. 媒体文件名中的 chatId 消毒

`media-downloader.ts` 中用 `chatId.replace(/:/g, "_")` 消毒 composite key 中的冒号。Discord 的三段式 key `discord:guild:chan` 会变成 `discord_guild_chan`，这是预期行为。

#### 7. `isDirectMessage` 判断

Telegram 的 `isDirectMessage` 在 `normalizeIncomingMessage` 中由 `chat.type === "private"` 或 `numericChatId > 0` 推断。Discord 需要独立的判断逻辑（DM channel 检测）。`nc-event.ts` 的新代码路径已经从事件字段读取 `isDirectMessage`，不再依赖 chatId 符号推断。

#### 8. 存储/展示双向转换总结

```
写入 DB（任何路径）→ 必须是 composite key
  └─ 如不确定来源是否已 composite → ensureCompositeId(getPlatform(chatId), value)

展示给 LLM（任何 prompt）→ 必须是 raw ID
  └─ getRawId(compositeValue)

Sandbox 安全检查 → 把 LLM 传来的 args 自动 compose 后比较
  └─ ensureCompositeId(platform, String(args[0]))
```

---

## Phase 1: Discord Adapter 基础

### Step 1.1: 配置结构

修改 `core/config.ts`：
- 新增 `DiscordConfig` 接口（`botToken`, `applicationId` 等）
- `AppConfig` 增加 `discord?: DiscordConfig`
- `config.yaml.example` 增加 discord 配置示例

修改 `main.ts`：根据配置条件性创建 adapter。

**验证**:
- 只配置 `telegram` 时，行为与之前完全一致
- 只配置 `discord` 时，不创建 TelegramAdapter（无报错）
- 两者都配置时，两个 adapter 都创建

---

### Step 1.2: DiscordAdapter 实现

**引入** discord.js 包，并参考文档 https://discord.js.org/docs/packages/discord.js/main

**新建** `src/adapter/discord-adapter.ts`，使用 `discord.js`。

核心职责：
- 连接到 Discord Gateway（使用 bot token）
- 监听 `messageCreate` 事件
- `normalizeIncomingMessage()` 转换为统一 `nc.message` 格式
  - `chatId` = `composeChatId("discord", guildId, channelId)` （三段式）
  - `chatType` = `private` / `group` / `channel`
  - `isDirectMessage` = 是否为 DM
  - `mentionsAgent` = 检查 `<@botUserId>`
  - `rawMessage` = Discord.js Message 对象
  - `mediaInfo` = Discord Attachment → 统一格式（`url` 字段）
- 实现 `PlatformAdapter` 接口：
  - `handleCall("discord.sendText", [chatId, text, opts])` — 发送消息
  - `handleCall("discord.sendMedia", [chatId, media, opts])` — 发送附件
  - `handleCall("discord.sendTyping", [chatId])` — 显示 typing
  - `getWriteMethods()` — 返回写操作列表
  - `downloadMedia(rawMessage, mediaRef)` — HTTP GET CDN URL

**验证**:
- 启动 Discord bot，在测试服务器发消息
- 确认 NC 收到 `nc.message` 事件，chatId 格式正确
- 确认 `observer.onMessage()` 接收到消息
- 确认消息落盘到 `message_log`（chatId 为 `discord:guildId:channelId`）

---

### Step 1.3: main.ts 多 Adapter 绑定

修改 `main.ts`：
- `sandbox.setHostCallHandler` 增加 Discord adapter 路由
- 多个 adapter 实例按 `canHandle(method)` 路由 host call
- `sendTyping` 函数根据 chatId 平台前缀调用对应 adapter

**验证**:
- Telegram + Discord 同时运行
- 两个平台的消息互不串扰
- 各自的 host call 正确路由

---

## Phase 2: Sandbox + CodeAct

### Step 2.1: Discord Sandbox 模块

**新建**:
- `src/sandbox/modules/discord.ts` — Discord API proxy（类似 telegram.ts）
- `src/sandbox/modules/discord.d.ts` — 类型定义（注入 LLM prompt）

修改 `capability-registry.ts`：
- 接收 `platformName` 参数
- 根据平台条件性注入 `ctx.tg` 或 `ctx.discord`

修改 `scene.ts`：
- `current` 从硬编码改为参数传入

修改 `code-act-executor.ts`：
- `loadApiTypeDefs()` 根据 chatId 平台前缀过滤 `.d.ts` 文件

**验证**:
- Discord channel 中触发 CodeAct 执行
- LLM 收到的 prompt 中包含 `discord.d.ts` 类型定义（不含 telegram.d.ts）
- LLM 生成的 `ctx.discord.sendText()` 调用正确执行
- Sandbox 安全限制生效（不能向其他 channel 发消息）

---

### Step 2.2: Guild ↔ Group 画像共享

修改 `main.ts` 和 `subagent-manager.ts`：
- Discord 的 `GroupModel` 存储在 guild 级别（`discord:{guildId}`）
- `SubagentManager.getOrCreate()` 对 Discord chatId 创建 channel 级 subagent
- Attend prompt 中 chatTitle 格式为 `{guildName} > #{channelName}`

**验证**:
- 同一 Guild 下不同 Channel 共享 GroupModel
- 不同 Channel 有独立的 TopicRegistry 和 Session
- Attend prompt 正确展示频道信息

---

## Phase 3: 媒体管线

### Step 3.1: Adapter-Owned Download

修改 `dispatch-handler.ts`：
- `downloadFn` 改为调用 adapter 的 `downloadMedia()` 方法
- 根据 chatId 平台前缀选择对应 adapter

修改 `message-enricher.ts` 和 `vision-processor.ts`：
- 支持从 `rawMessage` + adapter 回调下载媒体
- 支持 `MediaInfo.url` 直接 HTTP 下载（Discord Attachment）

**验证**:
- Discord 频道中发送图片，agent 能通过 vision 识别
- Telegram 的 fileId 下载路径不受影响

---

## Phase 4: 完整验证

### 4.1 Telegram-Only 回归

仅配置 `telegram`，运行完整功能测试：
- [ ] 消息接收 + Observer engagement 计算
- [ ] RecordingPipeline 话题聚类 + Triage
- [ ] Main Agent attend 决策
- [ ] CodeAct session 执行
- [ ] FastPath 快速回复
- [ ] 追问检测 (FeedbackLoop)
- [ ] 媒体/贴纸处理
- [ ] Reflection（反思）
- [ ] Session 持久化 + 恢复
- [ ] Dashboard WebSocket 实时展示

### 4.2 Discord-Only

仅配置 `discord`，运行完整功能测试：
- [ ] 消息接收 + 标准化
- [ ] Observer + RecordingPipeline
- [ ] Main Agent attend 决策
- [ ] CodeAct session 执行（`ctx.discord.*` API）
- [ ] 追问检测
- [ ] 媒体处理
- [ ] Session 持久化（三层路径）
- [ ] Dashboard 展示

### 4.3 双平台并行

同时配置 `telegram` + `discord`：
- [ ] 两个平台消息互不串扰
- [ ] GroupModel 正确隔离（Telegram chatId vs Discord guildId）
- [ ] Session 文件正确分离
- [ ] 同一 Guild 下多个 Channel 共享画像
- [ ] Dashboard 能区分两个平台的消息
- [ ] 一个平台的 CodeAct 不会调用另一个平台的 API
