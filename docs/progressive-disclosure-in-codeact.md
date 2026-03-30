# Progressive Disclosure & "npm as Skills" in CodeAct Architecture

## 我们的愿景 (Our Vision)
**"Make the entire npm your skill library."**

在传统的 Agent 架构中，为大语言模型（LLM）提供工具通常需要繁琐的包裹（Wrapping）和参数定义（如 JSON Schema）。当面对复杂的外部系统（如 GitHub API、Notion API）时，我们需要手动将庞大的 SDK 转化为几十个散碎的 Tools，这不仅增加了开发成本，还极易导致 LLM 的上下文窗口（Context Window）被铺天盖地的工具说明塞满，造成注意力分散（Context Bloat / Attention Dilution）。

在 CyberGroupmate 中，我们引入了基于 **CodeAct** 和 **渐进式披露（Progressive Disclosure）** 的全新架构理念。我们不把工具定死成 JSON Schema，而是给 LLM 提供一个可以直接执行原生 TypeScript / JavaScript 代码的沙盒，让它像真实开发者一样直接使用丰富的 `npm` 生态。

---

## 核心机制：渐进式文档披露 (Progressive Documentation Disclosure)

如果你把整个复杂的 SDK 文档直接塞给 LLM，它多半会晕头转向。我们在 CodeAct 两阶段执行机制（Two-Pass Code Generation）中引入了**无状态的动态文档解析与注入**：

### Pass 1：认知轮廓，精准索引 (The "Brief" Pass)
在每一轮的 System Prompt 中，LLM 只会看到所有已加载模块的**单行签名**（Brief Overview）。
例如，它只知道有这样一个对象：
```typescript
github.listIssues: 列出指定仓库的 Issue 列表
github.createIssue: 在指定仓库创建新的 Issue
ctx.tg.sendText: 发送文本消息到指定频道
```
由于这些定义极其轻量，它即便挂载了几十个 Skills，也不会占用系统太多的 Token，保证了 LLM 依然保持敏锐的核心逻辑思考能力。

### Pass 2：按需索取，精准滴灌 (The "Detailed" Pass)
当 LLM 准备采取行动，生成了如 `await github.listIssues(...)` 的代码时，Sandbox 并不会立刻执行。
我们的 **API Intent Extractor** 会利用正则静态扫描 LLM 刚刚写下的代码，提取出它意图调用的原生能力。

如果意图命中了一些复杂的模块（如 `github`），系统会触发 **Pass 2**：
动态读取这几个具体方法的**完整类型定义（包含详尽的 JSDoc、多行说明、具体参数和示例）**，像“翻开说明书的这一页”一样，注入给 LLM，并让它**基于详尽的说明重新审视自己刚写的代码**，确保参数、用法正确后，再进行真实执行。

### 记忆去重与压缩自适应 (Stateless Deduplication & Context Compaction)
LLM 的交互是在多轮流式对话中进行的：
- **无状态去重**：每次触发 Pass 2 时，系统会向前追溯历史消息（Messages History）。只要上下文中**已有**这本“说明书”（带有 `### module.method` 等标记），就不会重复注入，避免对话被反复出现的文档撑爆。
- **与 Session Compaction 的完美契合**：如果对话过长，旧的文档被上下文截断（Compact）清理掉了怎么办？无需担心！我们的检测机制是**基于当前可见上下文**的。一旦 LLM 的“认知”里失去了这块文档，而它又要调用该方法时，机制会自动补发一次缺失的说明，实现真正的随需取用。

---

## 技术实现：完全解耦的 npm Skills
我们如何定义一个 TS Skill？
开发者只需去独立的 Git 仓库 `Archeb/ts-skills` 中新建一个文件夹，并在里面做两件事：
1. `index.ts`（或者 `index.js`）：暴露标准的 SDK 实例（或封装的实例）。想用什么 npm 包，直接 `npm install`，在代码里自由引入。这是给 **Sandbox（Node.js Worker 进程）** 真实执行用的。
2. `.d.ts`：编写一份**人工精心裁剪**的 TypeScript 声明文件。在这个文件里，你不需要暴露完整的 npm 库接口，只暴露你**希望 LLM 认知的接口**（Cognitive Map），并配上简单易懂的 JSDoc。这段描述是给 **Host（LLM Prompt 处理器）** 静态读取并喂给 LLM 的。

**系统完全解耦：**
主程序完全不干涉你的 npm 包逻辑，只要它出现在 `workspace/skills/` 下，主程序就会在运行时（Runtime）利用 `dts-parser.ts` 以纯正则静态提取 `.d.ts`，组装成给 LLM 的“知识地图”。不仅实现了热插拔，更从根本上保证了核心内置能力与第三方组件在代码和静态编译期上的隔离。无需执行任何 npm 脚本，只需 clone 仓库即可生效，下一次对话 LLM 就能直接识别并使用。

---

## 架构优势总结 (Benefits)

1. **零封装成本 (Zero-wrapping cost)**：再也不用痛苦地把原本一个原生函数调用就能解决的事情，费尽心思地转化为各种复杂的 OpenAI JSON Schema Formats（还要维护巨大的参数映射层）。会写 TypeScript 就会写 Tool。
2. **无限可扩展性 (Infinite Scalability)**：利用“轻量概览 + 按需详述”机制，我们打破了 System Prompt 的长度魔咒。理论上你可以挂载几百个微小而具体的 Skills，LLM 只会在真正需要调用那个模块时，才去索要该模块的详细地图。
3. **安全与隔离并存 (Safety & Isolation)**：Host 进程仅做纯文本的静态正则表达式分析（绝不会意外 `require` 恶意模块），所有的 npm 模块实例和真正的代码执行都被限定在安全隔离的 Sandbox Worker 内运作。
4. **像真实程序员一样的工作流 (Human-like Workflow)**：这极度贴近真实程序员的工作状态——面对庞大的不知名 SDK，先通过 IDE 的智能提示看个函数名和短述（Pass 1 引导阶段）；如果真的要写复杂调用，再去悬停展开查看详细的 JSDoc，查阅完整的出入参和示例代码（Pass 2 请求阶段）；确保无误后书写执行。

**“Stop teaching LLMs how to parse your JSON tool definitions. Let them write executable code and read JSDoc instead.”**

---

## 延申：与当前主流 AI Agent "Skills Hub" 的对比

当前业界主流的 AI Agent 框架（如 LangChain 工具箱、Dify/Coze 插件、OpenAI GPTs Actions 等）也普遍提供所谓的 "Skills Hub" 或 "Plugin Store" 机制。但在底层逻辑上，我们的 **渐进式 CodeAct 沙盒方案** 实现了降维打击：

### 传统 Skills Hub 的阿喀琉斯之踵（Schema-based Tool Calling）
- **封装极其繁重（Wrapping Tax）**：开发者如果想让 Agent 拥有一个新技能，必须用 Python/TypeScript 编写工具类，然后手动提供冗长死板的 OpenAPI Schema（JSON），去定义每一个参数的类型、枚举、长度限制和用法。将一个原生的 SDK 强行转化为一堆松散的 Tools，不仅费时费力，还会丢失类型之间的连贯关系。
- **Context 上下文锁死**：每增加一个工具，Agent 的 System Prompt 就必须无脑吃进这个工具的全部 Schema。稍微复杂的技能库（包含二三十个端点）在初始化时就会瞬间吞噬几千个 Token，极大地稀释了模型的注意力（Attention），也注定了一个 Agent 无法同时挂载成百上千个技能。
- **胶水逻辑的黑盒化**：真实的业务场景往往是复合的：“先调用 A 获取列表 -> 用正则过滤找到符合条件的 ID -> 并发请求 B 获取详情”。在传统的工具调用范式下，LLM 只能笨拙地一轮一轮去猜参数调用 Tools；为了稳定，开发者往往只能在沙盒外部预先写死（Hardcode）这段胶水代码，将死板的功能重新包装成一个宏观工具。

### 基于原生 npm 生态的 CodeAct 降维打击
- **不重建车轮，npm 本身即是 Skills Hub**：我们不需要专门打造一个闭源的或者定制化的插件市场。有了 Node 沙盒，**拥有千万量级包的 NPM 仓库就是全世界最庞大、最成熟的 Skills Hub**。任何包（甚至是系统内置的 `crypto`、`fs`）都可以成为 LLM 的能力延伸，只需要几行 `import` 和极其精简的认知映射（`.d.ts`）。
- **将“参数填充器”升维为“全栈工程师”**：我们的 Agent 不再是一个只能通过补全特定 JSON 来调用外部黑盒的“填表员”。在面对上面的复合业务需求时，它会在它的 Sandbox 空间内直接使用 `for` 循环、正则匹配、甚至是 `Promise.all` 原生 JavaScript 特性，把 A 和 B 两个 SDK 行云流水地组合在一起执行，彻底夺回了逻辑编排的主动权。
- **极简映射，动态展开**：借由渐进式披露机制，即使我们给它挂载了极其庞大的如 AWS SDK 或 octokit，它也能在平时保持“一句话概览”的清醒头脑，只有真到了执行边缘，才优雅地通过 Pass 2 将手册展开阅读。

**传统模式让开发者写代码把 AI 连入 API；而在我们的 CodeAct 模式下，开发者只需把 SDK 放在桌子上，让 AI 自己去写代码。**
