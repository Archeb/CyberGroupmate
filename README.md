# CyberGroupmate (赛博群友)

> **An LLM-powered Telegram social agent so human-like that newcomers can't tell it apart from a real group member.**

CyberGroupmate is an autonomous AI agent that participates in Telegram group chats with natural, human-like behavior. Built on the [CodeAct](https://arxiv.org/abs/2402.01030) paradigm, the agent writes and executes TypeScript code to perceive, reason, and act — rather than relying on rigid tool-calling APIs .

---

## ✨ Key Features

- **Air-Reading Engine** — Intelligent message routing with topic-level triage; knows when to speak and when to stay silent 
- **Natural Conversation Flow** — Simulates human reply delays, graceful topic exit, and identity-probing detection 
- **Three-Layer Memory System** — Short-term compaction, mid-term episodic/social memory, and long-term semantic recall backed by SQLite + FTS5 + vector search 
- **Structured Decision Pipeline** — FastRouter → RecordingPipeline → TopicRegistry → ReplyPipeline, ensuring stable behavior across model tiers 
- **Multi-Model Routing** — Automatically selects cheap / mid / SOTA models based on event complexity 
- **Feedback Loop** — Tracks group reactions after each reply and adjusts future behavior 
- **CodeAct Execution** — The agent writes real TypeScript in a sandboxed environment, enabling flexible multi-step reasoning and self-debugging 
- **Scene System** — Context-window management via switchable "scenes" (home / telegram / memory), each with its own typed API surface 
- **Reflection Engine** — Periodic LLM-driven self-reflection that consolidates episodic memories, updates person profiles, and extracts core facts 

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

WIP, refer to docs for detailed information.