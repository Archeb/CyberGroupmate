# CyberGroupmate (赛博群友)

> **一个由代码驱动的群聊社交 Agent**

CyberGroupmate 是一个能够以自然、拟人的行为模式参与群聊的自主 AI Agent。基于 [CodeAct](https://arxiv.org/abs/2402.01030) 范式构建，该 Agent 通过编写并执行 TypeScript 代码来进行感知、推理和行动——而不是依赖死板的工具调用（Tool-calling）API。

---

## ✨ 核心特性

* **“读空气”引擎（氛围感知）** — 智能的消息路由与话题级分类；确切知道何时该发言，何时该保持沉默。
* **自然的对话流** — 模拟人类回复延迟、优雅地退出话题，以及具备身份试探检测（识别别人是否在测试它是不是 AI）。
* **三层记忆系统** — 短期记忆压缩、中期情景/社交记忆，以及基于 SQLite + FTS5 + 向量检索支持的长期语义召回。
* **结构化决策流水线** — 包含 FastRouter（快速路由） → RecordingPipeline（记录管线） → TopicRegistry（话题登记） → ReplyPipeline（回复管线），确保在不同层级的模型下行为依然稳定。
* **多模型路由** — 根据事件的复杂程度，自动智能调度 低成本 / 中等 / SOTA（最先进）模型。
* **反馈循环** — 追踪每次回复后群组的反应，并据此调整未来的行为模式。
* **CodeAct 执行机制** — Agent 会在沙盒环境中编写真实的 TypeScript 代码，从而实现灵活的多步推理与自我调试。
* **场景系统** — 通过可切换的“场景”（如 home / telegram / memory）进行上下文窗口管理，每个场景都拥有自己类型安全的 API 接口。
* **反思引擎** — 由 LLM 周期性驱动的自我反思机制，用于巩固情景记忆、更新人物画像并提取核心事实。

---

## 🐳 Docker 部署

### 快速启动

```bash
# 1. 准备配置文件
cp config.example.yaml config.yaml
# 编辑 config.yaml，填写 Telegram 凭据和 LLM API Key

# 2. 启动
docker compose up -d

# 3. 查看日志
docker compose logs -f
```

### Userbot 首次登录

如果使用 userbot 模式，首次启动需要输入 OTP 验证码：

```bash
docker attach cybergroupmate
# 输入验证码后按 Ctrl+P, Ctrl+Q 脱离（不要 Ctrl+C）
```

### 数据持久化

运行数据（SQLite 数据库、Telegram 会话、事件日志等）存储在 Docker named volume `cybergroupmate-data` 中。

```bash
# 备份数据
docker run --rm -v cybergroupmate-data:/data -v $(pwd):/backup alpine tar czf /backup/cybergroupmate-backup.tar.gz -C /data .

# 恢复数据
docker run --rm -v cybergroupmate-data:/data -v $(pwd):/backup alpine tar xzf /backup/cybergroupmate-backup.tar.gz -C /data
```

### 自定义配置

所有配置通过 `config.yaml` 文件管理（不使用环境变量）。修改配置后重启容器即可生效：

```bash
docker compose restart
```

---

## 🏗 Architecture Overview

Refer to [docs/architecture_v2.md](docs/architecture_v2.md) for detailed information.

## 📄 LICENSING

本项目采用 AGPLv3 协议。对于使用本项目（及其衍生版本）作为 QQ、Telegram、Discord 等平台聊天机器人的行为，任何在群组中与该机器人产生交互的用户，均被视为 AGPLv3 第13条所指的‘通过计算机网络远程交互的用户’。部署者必须在机器人的回复、状态签名或群组公告中，显著提供获取其修改后源代码的链接。