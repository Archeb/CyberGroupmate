# CyberGroupmate (赛博群友)

> **一个由代码驱动的群聊社交 Agent**

CyberGroupmate 是一个能够以自然、拟人的行为模式参与群聊的自主 AI Agent。基于 [CodeAct](https://arxiv.org/abs/2402.01030) 范式构建，该 Agent 通过编写并执行代码和 Shell 命令来进行感知、推理和行动。

Join our discussion on Telegram! [https://t.me/cybergroupmate](https://t.me/cybergroupmate)

---

![CodeAct面板](docs/images/image1.png)
![LLM日志记录](docs/images/image2.png)
![记忆面板](docs/images/image3.png)


## 💡 What Makes This Different

### Meta Agent / Subagent: Cross-Group Orchestration

大多数聊天机器人是单群、被动响应的。CyberGroupmate 采用 **Meta Agent — Subagent** 分层架构，让 Agent 具备了跨群感知和跨群行动的能力。

一个全局的 Meta Agent 通过编写 JavaScript 代码来调用编排 API（`dispatch.taskToGroup()`、`conversations.query()`、`memory.searchEntities()` 等），将任务分发到各个群的 Subagent Executor。Executor 完成任务后，执行结果通过 Callback Queue 回流到 Meta Agent，形成闭环反馈。Meta Agent 可以追踪任务状态、设置定时提醒、甚至在多个群之间协调行动。而且，Subagent 之间也可以互相 dispatch 任务并且收到 callback。

通过 Callback 闭环，Agent 内部始终能掌握自己刚刚做了什么，还能够真正理解“A 群/私聊有人提到了和 B 群相关的话题”并主动采取行动，给群友们带来一种“和我聊天的始终都是一个人”的整体感。

### Context Engine: Structured Prompt Assembly with 90%+ Cache Rates

我们没有手动拼接字符串来构建 Prompt。Context Engine 用结构化的代码声明上下文中每一部分的性质：
- **static**: 不变的内容（系统指令），跨轮次缓存
- **delta**: 只发送增量（消息按 ID diff，人物画像按 userId diff）
- **ephemeral**: 仅当前轮可见（记忆搜索结果、贴纸目录）
- **volatile**: 每轮重新生成

Delta 计算发生在类型化的结构数据层，从各个数据源获取的结构化数据到渲染到自然语言只会在最末端发生一次。这意味着静态和未变化的 Prompt 前缀在多轮对话中保持字节级一致，LLM API 的 Prompt Cache 可以大面积命中。DeepSeek V4 Flash 在 Subagent 模块的实测缓存率达到 **90%+**。

更重要的是，每次渲染都会生成一个 **Context Manifest**，可以直接在 Dashboard 的 LLM Log 面板中查看——哪些部分被缓存了、哪些是增量、哪些是临时内容，一目了然。

### Progressive Disclosure: “npm as Skills”

传统 Agent 要把 SDK 包装成 JSON Schema 的 Tool 定义。我们的方法是：**让 Agent 直接写 TypeScript，文档按需注入。**

- **Pass 1**: System Prompt 只包含单行签名（`search: 搜索网页内容`），几十个模块只占数百 Token
- **Pass 2**: 代码运行失败时，提取代码中的 API 调用意图，精准注入对应方法的完整 `.d.ts` 文档

关键洞察：Agent 自己写出的代码就是最好的意图信号——不需要额外的 Router 模型或 RAG 检索。这让技能扩展变得极其廉价：写一个 `.d.ts` 和 `index.ts`，丢进 `workspace/skills/` 目录，下次对话 Agent 就能使用。

详见 [Progressive Disclosure in CodeAct](docs/progressive-disclosure-in-codeact.md)。

### Real-Time Observable Dashboard

我们始终认为**可观测性和框架能力同等重要**。Dashboard 提供 13+ 个实时面板，覆盖系统的每一个层面：

- **CodeAct 面板**: 实时查看 Agent 正在执行的代码、思考过程、每一步的 observation
- **LLM Log 面板**: 完整的 LLM 调用日志，包括请求/响应、Token 用量、**Context Manifest**（缓存率可视化）
- **Memory 面板**: 搜索、浏览、编辑记忆条目
- **Config 面板**: 实时编辑配置并热重载，无需重启

你几乎可以在 Dashboard 中理解 Agent 的每一个决策、每一次行动。

---

## ✨ 核心特性

* **Meta Agent / Subagent 架构** — 全局 Meta Agent 编写代码进行跨群编排，per-group Subagent Executor 执行具体任务，Callback Queue 闭环反馈。
* **CodeAct 执行** — Agent 在隔离沙盒中编写真实的 TypeScript 代码，Notebook 式变量持久化，Promise 自动追踪，30+ 内置模块。
* **Context Engine** — 结构化 Prompt 组装，类型化 delta 计算，四种缓存策略 × 四种历史策略，Manifest 可视化，90%+ 缓存命中率。
* **渐进式文档披露** — 两阶段文档注入（轻量概览 → 错误后完整文档），NPM 包即技能，零封装成本。
* **Attention Accumulator** — 三层优先级（直接提及 > 回调/定时 > 话题信号），Pressure 评分（活跃度 × Dunbar 亲密度 × 时间衰减）。
* **三层记忆** — 短期工作记忆 + 中期情景/社交记忆（SQLite）+ 长期语义记忆（向量检索），Dunbar 分层，周期性反思引擎。
* **Recording Pipeline** — 后台持续分析消息流，自动聚类话题、追踪生命周期、生成信号。
* **多平台** — Telegram（Bot + Userbot）、Discord、QQ（OneBot/NapCat），统一适配层。
* **多模型路由** — 按组件分配不同 LLM（编排用高端模型，对话用中端，后台分析用廉价模型），API Key 池化负载均衡。
* **实时 Dashboard** — 13+ 面板，WebSocket 推送，CodeAct 实时调试，LLM 调用追踪，记忆搜索编辑，配置热重载。
* **原生多模态** — 图片、贴纸、视频、动图的识别与理解。
* **反思引擎** — 周期性 LLM 自我反思，巩固情景记忆、更新人物画像、提取核心事实。
* **Prometheus 指标** — Token 用量、请求延迟、TPS、群组统计、系统健康，兼容标准 scraper。

支持平台：Telegram、Discord、QQ (OneBot)

## 🏗 系统架构​

请参考 [docs/architecture_v4.md](docs/architecture_v4.md) 获取详细的架构文档。

也可以[直接阅读我们的 Prompts](system-prompts)，它们的更新频率高于架构文档，能反映最新的设计意图。建议结合架构文档和 Prompts 一起阅读。

另外，也请参考 [作者在用的 PERSONA（人格设置文件）](docs/PERSONA.example.md) 来设置你的赛博群友

## 🖥️ 本机原生运行

原生运行不依赖 Docker，适合直接在 Linux 主机上常驻服务。运行时数据默认写入项目根目录下的 `workspace/`。

### 环境准备

需要 Node.js 22 或更新版本，以及用于编译 native npm 模块的基础工具：

```bash
# Debian/Ubuntu 示例
sudo apt-get update
sudo apt-get install -y nodejs npm python3 make g++ \
  ffmpeg zip unzip wget curl jq imagemagick git \
  poppler-utils dnsutils

# 推荐安装 uv；pandoc 仅在需要文档转换能力时安装
sudo apt-get install -y uv pandoc
```

如果机器无法直连 npm 官方源，可以临时使用可访问的镜像：

```bash
npm config set registry https://registry.npmmirror.com
```

### 安装与构建

```bash
# 1. 准备配置文件
cp config.example.yaml config.yaml
# 编辑 config.yaml，填写平台凭据、LLM API Key、Dashboard 等配置

# 2. 安装后端依赖
pnpm install --frozen-lockfile

# 3. 构建 Dashboard 静态资源
pnpm -C src/dashboard/ui install --frozen-lockfile
pnpm dashboard:build

# 4. 启动
LOG_LEVEL=info pnpm start
```

启动后 Dashboard 默认监听 `config.yaml` 中配置的地址与端口；常见部署为 `http://<host>:6767`。

### systemd 常驻

生产环境建议用 systemd 托管进程。将 `WorkingDirectory` 和 `User` 改成实际部署路径与运行用户：

```ini
[Unit]
Description=CyberGroupmate native service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=aosc
Group=aosc
WorkingDirectory=/home/aosc/docker/CyberGroupmate
Environment=NODE_ENV=production
Environment=LOG_LEVEL=info
Environment=PATH=/usr/bin:/bin:/usr/sbin:/sbin
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
TimeoutStopSec=30
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
```

保存为 `/etc/systemd/system/cybergroupmate.service` 后：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cybergroupmate.service
systemctl status cybergroupmate.service
journalctl -u cybergroupmate.service -f
```

### 原生运行数据

关键数据位于 `workspace/`，例如：

* `workspace/memory.db*`：记忆数据库及 WAL/SHM。
* `workspace/tg-session/`：Telegram userbot 登录会话。
* `workspace/sessions/`：Subagent/CodeAct 会话状态。
* `workspace/Downloads/`、`workspace/media/`：运行中保存和引用的媒体资产。
* `workspace/skills/`、`workspace/.local/`、`workspace/lib/`：Agent 技能和持久化运行环境。

备份或迁移时，通常可以排除这些可再生成的缓存目录：

```text
workspace/media-cache/
workspace/.cache/
workspace/tmp/
**/__pycache__/
*.pyc
*.pyo
```

## 🐳 Docker 部署

### 方式一：使用 GHCR 预构建镜像（推荐）

每次 push 到 agentic 分支或发布新版本时，GitHub Actions 会自动构建并推送镜像到 GHCR。无需本地编译，开箱即用。

```bash
# 1. 拉取镜像
docker pull ghcr.io/archeb/cybergroupmate:agentic

# 2. 准备配置文件
mkdir -p cybergroupmate && cd cybergroupmate
cp ../config.example.yaml config.yaml

# 3. 启动（使用 host 网络模式以便连接本地服务）
docker run -d \
  --name cybergroupmate \
  --restart unless-stopped \
  --network host \
  -v \$(pwd)/workspace:/app/workspace \
  -v \$(pwd)/config.yaml:/app/config.yaml \
  ghcr.io/archeb/cybergroupmate:agentic

# 4. 查看日志
docker logs -f cybergroupmate
```

`agentic` 分支还会额外发布三个工具预装变体：

```bash
docker pull ghcr.io/archeb/cybergroupmate:agentic-with-cc       # 预装 Claude Code
docker pull ghcr.io/archeb/cybergroupmate:agentic-with-codex    # 预装 Codex CLI
docker pull ghcr.io/archeb/cybergroupmate:agentic-with-copilot  # 预装 Copilot CLI
```

其中 `agentic-with-cc` 通过 Anthropic 官方原生安装脚本安装 Claude Code；`agentic-with-codex` 和 `agentic-with-copilot` 分别安装官方 `@openai/codex`、`@github/copilot` npm 包。运行时仍需按各工具要求完成认证。

发布版本（v* tag）也会同步推送，可使用语义化版本号拉取：

```bash
docker pull ghcr.io/archeb/cybergroupmate:1.0.0
```

可用标签请参考 [GHCR Packages 页面](https://github.com/Archeb/CyberGroupmate/pkgs/container/cybergroupmate)。

### 方式二：本地构建

如果需要自定义修改或 GHCR 镜像不可用，可以从源码本地构建：

```bash
# 1. 克隆仓库
git clone https://github.com/Archeb/CyberGroupmate.git
cd CyberGroupmate

# 2. 准备配置文件
cp config.example.yaml config.yaml

# 3. 构建并启动
docker compose up -d --build

# 4. 查看日志
docker compose logs -f
```

## 📄 LICENSING

本项目采用 AGPLv3 协议。

对于使用本项目（及其衍生版本）作为 QQ、Telegram、Discord 等平台聊天机器人的行为，任何在群组中与该机器人产生交互的用户，均被视为 AGPLv3 第13条所指的‘通过计算机网络远程交互的用户’。

部署者必须在机器人的回复、状态签名或群组公告中，显著提供获取其修改后源代码的链接。
