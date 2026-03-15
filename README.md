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

## 🏗 Architecture Overview

WIP, refer to docs for detailed information.