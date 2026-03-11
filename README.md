# CyberGroupmate (赛博群友)

> **An LLM-powered Telegram social agent so human-like that newcomers can't tell it apart from a real group member.**

CyberGroupmate is an autonomous AI agent that participates in Telegram group chats with natural, human-like behavior. Built on the [CodeAct](https://arxiv.org/abs/2402.01030) paradigm, the agent writes and executes TypeScript code to perceive, reason, and act — rather than relying on rigid tool-calling APIs [[1]](file://Implementation_Plan.md).

---

## ✨ Key Features

- **Air-Reading Engine** — Intelligent message routing with topic-level triage; knows when to speak and when to stay silent [[1]](file://Implementation_Plan.md)
- **Natural Conversation Flow** — Simulates human reply delays, graceful topic exit, and identity-probing detection [[1]](file://Implementation_Plan.md)
- **Three-Layer Memory System** — Short-term compaction, mid-term episodic/social memory, and long-term semantic recall backed by SQLite + FTS5 + vector search [[1]](file://Implementation_Plan.md)
- **Structured Decision Pipeline** — FastRouter → RecordingPipeline → TopicRegistry → ReplyPipeline, ensuring stable behavior across model tiers [[1]](file://Implementation_Plan.md)
- **Multi-Model Routing** — Automatically selects cheap / mid / SOTA models based on event complexity [[1]](file://Implementation_Plan.md)
- **Feedback Loop** — Tracks group reactions after each reply and adjusts future behavior [[1]](file://Implementation_Plan.md)
- **CodeAct Execution** — The agent writes real TypeScript in a sandboxed environment, enabling flexible multi-step reasoning and self-debugging [[2]](file://main.ts)
- **Scene System** — Context-window management via switchable "scenes" (home / telegram / memory), each with its own typed API surface [[1]](file://Implementation_Plan.md)
- **Reflection Engine** — Periodic LLM-driven self-reflection that consolidates episodic memories, updates person profiles, and extracts core facts [[1]](file://Implementation_Plan.md)

---

## 🏗 Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Platform Adapter Layer                    │
│               (TelegramAdapter — start/stop/normalize)       │
└──────────────────────────┬──────────────────────────────────┘
                           │ NCEvent (standardized)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                NotificationCenter (Event Bus)                │
│                  + events.jsonl persistence                   │
└──────────────────────────┬──────────────────────────────────┘
                           │ nc.drain()
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  Cognition Pipeline (Phase 6)                │
│                                                              │
│  FastRouter ──┬── FAST_PATH (@/reply/DM) ──► ReplyPipeline  │
│               ├── ENGAGED (active topic)  ──► EngagedHandler │
│               └── RECORDING (observe)     ──► RecordingPipe  │
│                                                              │
│  TopicRegistry (10-state machine)    ModelRouter (rule-based)│
│  FeedbackLoop (post-reply eval)      ContextAssembler        │
└──────────────────────────┬──────────────────────────────────┘
                           │ ReplyTask
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                 Execution Layer (CodeAct)                     │
│                                                              │
│  Session Runner (multi-turn LLM ↔ Sandbox)                   │
│  Sandbox Worker (new Function() + persistent ctx namespace)  │
│  SceneManager (home / telegram / memory)                     │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                     Memory V2 (SQLite)                        │
│  topics │ core_facts │ person_identities │ person_group_profiles │
│  message_log │ FTS5 indexes │ vector embeddings              │
└─────────────────────────────────────────────────────────────┘
```

[[2]](file://main.ts) [[1]](file://Implementation_Plan.md)

---

## 📋 Prerequisites

| Requirement | Version |
|-------------|---------|
| **Node.js** | ≥ 22 |
| **npm** | ≥ 9 |
| A Telegram Bot Token **or** Userbot session | — |
| An LLM API key (Anthropic / OpenAI-compatible) | — |

---

## 🚀 Quick Start

### 1. Clone & Install

```bash
git clone git@github.com:Archeb/CyberGroupmate.git
cd CyberGroupmate
npm install
```

### 2. Configure

Copy the example config and fill in your credentials:

```bash
cp config.example.yaml config.yaml
```

**Minimum required configuration** in `config.yaml`:

```yaml
llm_profiles:
  default:
    provider: anthropic        # or "openai"
    base_url: https://api.anthropic.com
    model: claude-sonnet-4-20250514
    api_key: sk-ant-...
    temperature: 0.7
    max_tokens: 4096

model_tiers:
  cheap: default
  mid: default
  sota: default

persona:
  name: 赛博群友
  description: |
    你是一个活泼、有趣的群友……（自定义人格描述）

telegram:
  mode: bot                    # "bot" or "userbot"
  api_id: "12345678"
  api_hash: "your_api_hash"
  bot_token: "123456:ABC-..."  # bot mode
  # phone: "+861xxxxxxxxxx"    # userbot mode
```

Environment variables (`TG_API_ID`, `TG_API_HASH`, `TG_BOT_TOKEN`, etc.) override the YAML values [[1]](file://Implementation_Plan.md).

### 3. Prepare Agent Docs

Place your system prompt and bootstrap prompt in the workspace:

```bash
mkdir -p workspace/agent-docs
# Edit these files to customize agent behavior:
#   workspace/agent-docs/system-prompt.md
#   workspace/agent-docs/bootstrap-prompt.md
```

### 4. Run

```bash
npx tsx src/main.ts
```

On first launch the agent will run a **bootstrap** sequence — connecting to Telegram and initializing the runtime. Successful bootstrap code is cached in `workspace/bootstrap-code.json` for fast replay on subsequent restarts [[2]](file://main.ts) [[1]](file://Implementation_Plan.md).

---

## 🛠 CLI Tools

CyberGroupmate ships with a CLI for debugging and inspection [[3]](file://cli.ts):

```bash
npx tsx src/cli.ts <command> [args...]
```

| Command | Description |
|---------|-------------|
| `sandbox` | Interactive Sandbox REPL — execute TypeScript directly |
| `notify [type] [text]` | Push a notification event into the queue (`--urgent` flag supported) |
| `drain` | View and flush the current notification queue |
| `memory <subcmd>` | Query the memory system |
| `config` | Inspect loaded configuration and file status |
| `status` | View agent state, recent events, and memory statistics |
| `dry-run <file.jsonl>` | Replay historical messages for offline evaluation |

### Memory Sub-commands

```bash
npx tsx src/cli.ts memory recall "京都旅行"       # Hybrid search (vector + FTS5)
npx tsx src/cli.ts memory browse "谁提过 Rust"    # Browse message archive
npx tsx src/cli.ts memory reflect --chat -100123  # Trigger reflection for a chat
npx tsx src/cli.ts memory status                  # Database statistics
```

### Dry-Run (Offline Evaluation)

Replay exported chat history through the full pipeline without sending any messages [[3]](file://cli.ts) [[1]](file://Implementation_Plan.md):

```bash
npx tsx src/cli.ts dry-run history.jsonl --chat-id -100123456 --days 30 --reflect
```

Options: `--chat-id <id>`, `--days <n>`, `--reflect`, `--memory-db <path>`

---

## 📁 Project Structure

```
cybergroupmate/
├── src/
│   ├── main.ts                  # Orchestrator — bootstrap → event loop
│   ├── cli.ts                   # CLI debugging tools
│   ├── core/                    # Config, logger, LLM client, safety
│   ├── adapter/                 # Platform adapters (Telegram)
│   ├── sandbox/                 # CodeAct execution engine
│   ├── event/                   # NotificationCenter + compaction
│   ├── pipeline/                # Decision pipeline (Phase 6)
│   ├── memory-v2/               # Three-layer memory system
│   ├── scenes/                  # Scene definitions + shared type defs
│   └── agent/                   # Agent docs system
├── system-prompts/              # LLM prompt templates
├── config.yaml                  # Runtime configuration
├── config.example.yaml          # Annotated config template
├── workspace/                   # Runtime data (gitignored)
│   ├── memory.db                # SQLite memory database
│   ├── events.jsonl             # Append-only event log
│   ├── agent-state.md           # Persistent agent state
│   ├── bootstrap-code.json      # Cached bootstrap code
│   ├── tg-session/              # Telegram session files
│   ├── agent-docs/              # Agent-readable documents
│   └── sessions/                # Session transcripts
├── tests/
└── docs/
```

[[1]](file://Implementation_Plan.md)

---

## ⚙️ Configuration Reference

CyberGroupmate uses a layered configuration: **environment variables > config.yaml > defaults** [[1]](file://Implementation_Plan.md).

### LLM Profiles & Model Tiers

Define named LLM profiles and assign them to three cost tiers:

```yaml
llm_profiles:
  gemini-flash:
    provider: openai
    base_url: https://generativelanguage.googleapis.com/v1beta/openai
    model: gemini-2.0-flash
    api_key: ...
    temperature: 0.7
    max_tokens: 4096

  claude-sonnet:
    provider: anthropic
    base_url: https://api.anthropic.com
    model: claude-sonnet-4-20250514
    api_key: ...
    temperature: 0.7
    max_tokens: 8192

model_tiers:
  cheap: gemini-flash       # Recording Pipeline, Triage, Feedback
  mid: claude-sonnet         # Main agent sessions, Reply Pipeline
  sota: claude-sonnet        # Complex @ queries, Playbook generation
```

[[1]](file://Implementation_Plan.md)

### Reflection Configuration

```yaml
reflection:
  silence_threshold: 7200    # Trigger after 2h of chat silence
  max_interval: 86400        # Force trigger every 24h
  awake_hours: [8, 24]       # Only reflect during these hours
  timezone: "Asia/Shanghai"
  check_interval: 300        # Check every 5 minutes
```

[[2]](file://main.ts) [[1]](file://Implementation_Plan.md)

### Notification Tuning

```yaml
notification:
  urgent_words: ["?", "？", "呢", "吗"]
```

---

## 🔄 How It Works

### Event Loop

1. **TelegramAdapter** connects to Telegram and pushes standardized `NCEvent`s into the NotificationCenter [[2]](file://main.ts)
2. **Main loop** drains events in batches (with configurable batch window and urgency detection) [[2]](file://main.ts)
3. **FastRouter** classifies each message into one of three paths [[1]](file://Implementation_Plan.md):
   - **FAST_PATH** — Direct @mentions, replies to agent, DMs → immediate CodeAct session
   - **ENGAGED** — Belongs to an active conversation topic → EngagedTopicHandler
   - **RECORDING** — Normal group chat → RecordingPipeline buffer
4. **RecordingPipeline** flushes buffered messages (50 msgs or 2 min silence), performs LLM topic clustering and triage, updates TopicRegistry, and writes to Memory V2 [[1]](file://Implementation_Plan.md)
5. **ReplyPipeline** assembles context (scene focus + latent memory) and creates `ReplyTask`s [[2]](file://main.ts) [[1]](file://Implementation_Plan.md)
6. **CodeAct Session Runner** executes multi-turn LLM ↔ Sandbox interactions until the agent finishes (no more code blocks) [[2]](file://main.ts)
7. **Compaction** extracts summaries, facts, and person updates from the session transcript [[1]](file://Implementation_Plan.md)
8. **FeedbackLoop** monitors group reactions for 3 minutes after each agent reply [[2]](file://main.ts) [[1]](file://Implementation_Plan.md)

### Bootstrap & Recovery

- On first run, the agent goes through an LLM-guided bootstrap to initialize its environment [[2]](file://main.ts)
- Successful bootstrap code is cached and replayed on restart; if replay fails, a full LLM bootstrap is re-run [[2]](file://main.ts) [[1]](file://Implementation_Plan.md)
- If the sandbox process crashes, the orchestrator automatically restarts it, replays bootstrap, and re-queues pending events [[2]](file://main.ts) [[1]](file://Implementation_Plan.md)

---

## 🧠 Memory System (V2)

A three-layer memory architecture built on SQLite [[1]](file://Implementation_Plan.md):

| Layer | Contents | Mechanism |
|-------|----------|-----------|
| **Short-term** | Session compaction summaries | Automatic post-session extraction |
| **Mid-term** | Topic episodes, person profiles, group models | RecordingPipeline + Reflection |
| **Long-term** | Core facts, consolidated knowledge | Reflection engine (merge + prune) |

**Retrieval**:
- `memory.recall(query)` — Hybrid search combining vector similarity (FNV-1a n-gram embeddings or OpenAI embeddings) with FTS5 keyword matching [[1]](file://Implementation_Plan.md)
- `memory.browseHistory(request)` — LLM-guided deep reading of message archives [[1]](file://Implementation_Plan.md)
- `memory.reflect(chatId)` — Periodic reflection that consolidates episodes, updates Dunbar-tier person profiles, and extracts durable facts [[1]](file://Implementation_Plan.md)

---

## 📊 Observability

| Artifact | Location | Description |
|----------|----------|-------------|
| Event log | `workspace/events.jsonl` | Append-only log of all system and external events [[1]](file://Implementation_Plan.md) |
| Session transcripts | `workspace/sessions/` | Full LLM conversation history per session [[1]](file://Implementation_Plan.md) |
| Agent state | `workspace/agent-state.md` | Persistent agent self-description and working memory [[2]](file://main.ts) |
| Structured logs | stdout/stderr | Configurable via `LOG_LEVEL` and `LOG_FORMAT` env vars [[1]](file://Implementation_Plan.md) |

```bash
LOG_LEVEL=debug LOG_FORMAT=json npx tsx src/main.ts
```

---

## 🧪 Testing

```bash
npx tsx --test           # Run all tests
npx tsx --test tests/    # Run tests in specific directory
```

---

## 🗺 Roadmap

| Phase | Status | Description |
|-------|--------|-------------|
| **1–5** | ✅ Complete | Core runtime, CodeAct engine, memory, scenes, compaction, CLI |
| **6A** | ✅ Complete | Memory V2, Air-Reading Engine, Recording Pipeline, Dry-Run, Model Router |
| **6B** | ✅ Complete | Ingress Boundary Refactor, Reply Pipeline, Action Surface, Skills, Feedback Loop |
| **7.1** | 📝 Planned | Playbook System — SOTA-generated behavioral guides for weaker models |
| **7.2** | 📝 Planned | Skill Auto-Generation — SOTA intervenes on failure and creates reusable skills |
| **7.3** | 📝 Planned | CoT Template Distillation — Extract chain-of-thought templates from successful interactions |
| **7.4** | 📝 Planned | Cost Control — Daily budget controller and model-tier cost strategy |
| **7.5** | 📝 Planned | Degradation Strategy — Three-level graceful degradation |

[[1]](file://Implementation_Plan.md)

---

## 💰 Estimated Cost (4,000 messages/day)

| Component | Model Tier | Daily Cost (Gemini Flash) |
|-----------|-----------|--------------------------|
| Recording Pipeline | Cheap | ~$0.17 |
| Engaged Topic Triage | Cheap | ~$0.02 |
| Reply Pipeline | Mid | ~$0.10–0.25 |
| Feedback Loop | Cheap | ~$0.02 |
| Compaction | Cheap/Mid | ~$0.05–0.10 |
| **Total** | — | **~$0.36–0.56/day** |

Monthly estimate: **$10–20** (cheap + mid models only) [[1]](file://Implementation_Plan.md)

---

## 📄 License

This project is currently unlicensed. Please contact the repository owner for usage terms.

---

## 🙏 Acknowledgments

- Architecture inspired by the [CodeAct paper](https://arxiv.org/abs/2402.01030) (Wang et al., 2024) [[1]](file://Implementation_Plan.md)
- Telegram client powered by [@mtcute/node](https://github.com/mtcute/mtcute)
- Memory backed by-sqlite3](https://github.com/WiseLibs/better-sqlite3) with FTS5
