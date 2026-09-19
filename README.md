# Harbor

[![License: MIT / Proprietary](https://img.shields.io/badge/license-MIT%20%2F%20Proprietary-blue.svg)](#license)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun%201.1+-black.svg)](https://bun.sh)
[![System One: Neural Daemon](https://img.shields.io/badge/System%20One-GLiNER%20%2B%20FastAPI%20(MPS%2FCPU)-brightgreen.svg)](#1-harbor-system-one-neural-daemon-servicesystem_one)
[![Dynamic Turn-Sieve](https://img.shields.io/badge/token%20savings-60--80%25%20Turn--Sieve-purple.svg)](#2-dynamic-turn-sieve--skill-routing-devharbor-tssrcskillsts)
[![Universal MCP](https://img.shields.io/badge/MCP-Claude%20%7C%20Cursor%20%7C%20OpenCode%20%7C%20Codex%20%7C%20Antigravity-orange.svg)](#wire-up-an-agent)

**Harbor** is the hypervisor, capability gatekeeper, and context management engine for autonomous AI coding agents. 

Modern coding agents degrade when overwhelmed by massive prompt bloat (loading hundreds of tools into the system prompt) and long-running context exhaustion. Harbor solves this by introducing a **split-layer architecture**: a sub-50ms non-autoregressive **System One Neural Daemon** that dynamically routes only the exact tools and skills needed per turn, coupled with **Room-Gated Capability Sandboxing**, **Neural Context Compaction**, and an in-process **Universal MCP Gateway** compatible with every major coding agent.

The npm package and library import is **`harbor-tugboat`**; the binary command is **`harbor`**.

---

## 🏛️ Architecture Overview

```
   ┌─────────────────────────────────────────────────────────────────────────┐
   │                        AI CODING AGENTS (CLIENTS)                       │
   │   Claude Code   │   Cursor   │   OpenCode   │   Antigravity   │   Pi    │
   └────────────────────────────────────┬────────────────────────────────────┘
                                        │ Universal MCP Gateway (stdio)
                                        ▼
   ┌─────────────────────────────────────────────────────────────────────────┐
   │                            HARBOR HYPERVISOR                            │
   │                                                                         │
   │  ┌─────────────────────────┐             ┌───────────────────────────┐  │
   │  │ Room Capability Sandbox │             │  Neural Context Compactor │  │
   │  │ (Domain Rules & Scopes) │             │  (Salience LRU Eviction)  │  │
   │  └────────────┬────────────┘             └─────────────┬─────────────┘  │
   │               │                                        │                │
   │               ▼                                        ▼                │
   │  ┌───────────────────────────────────────────────────────────────────┐  │
   │  │         Dynamic Turn-Sieve (Sub-50ms Skill & Tool Router)         │  │
   │  └─────────────────────────────────┬─────────────────────────────────┘  │
   └────────────────────────────────────┼────────────────────────────────────┘
                                        │ Local IPC / HTTP
                                        ▼
   ┌─────────────────────────────────────────────────────────────────────────┐
   │                 HARBOR SYSTEM ONE NEURAL DAEMON (PORT 8000)             │
   │                                                                         │
   │   • POST /v1/extract       (GLiNER Zero-Shot Span Extraction, ~20ms)    │
   │   • POST /v1/decide        (Non-Autoregressive Decision Primitives)     │
   │   • POST /v1/salience      (Neural Turn-Level Salience Scoring)         │
   │   • POST /v1/route-skills  (Turn-by-Turn Dynamic Prompt Sieve)          │
   └─────────────────────────────────────────────────────────────────────────┘
```

---

## 🚀 Key Systems & Core Capabilities

### 1. Harbor System One Neural Daemon (`services/system_one/`)
A high-throughput, transparent FastAPI microservice running locally on Apple Silicon Metal (`mps`) or Hostinger VPS Docker (`cpu`):
- **Interactive OpenAPI Documentation:** Live Swagger UI available at `http://127.0.0.1:8000/docs`.
- **Sub-25ms Zero-Shot Extraction (`POST /v1/extract`):** Powered by an embedded bidirectional encoder model ([`urchade/gliner_medium-v2.1`](https://github.com/urchade/GLiNER)). Extracts arbitrary user-defined entity spans (tools, file paths, error codes, PII) in ~20ms with $<450\text{MB}$ RAM footprint.
- **Fast Decision Primitives (`POST /v1/decide`):** Executes categorical `Choice`, calibrated `Noul` (probability), and ordinal `Score` decisions non-autoregressively without slow multi-second LLM reasoning.
- **Neural Salience Scoring (`POST /v1/salience`):** Evaluates multi-turn conversation logs and scores turn relevance for precision compaction.
- **Turn-Level Skill Routing (`POST /v1/route-skills`):** Matches incoming user turn prompts against available skill catalogs to extract only the relevant subset.

### 2. Dynamic Turn-Sieve & Skill Routing (`dev/harbor-ts/src/skills.ts`)
Coding agents typically inject all available skills (often 150–400+ markdown files) directly into the system prompt, ballooning context windows to 40k–60k tokens and causing model hallucinations and severe latency.
- **The Turn-Sieve Solution:** Harbor intercepts every turn prompt in flight and queries the System One daemon.
- **Surgical Context Loading:** Injects only the 1 to 3 skills explicitly required for the current turn.
- **Measurable Impact:** Reduces system prompt token overhead by **60% to 80%**, keeping models fast, responsive, and focused.

### 3. Room-Gated Capability Isolation
Harbor organizes agent work into isolated **Rooms** (`~/rooms/<domain>/`):
- **Domain Scoping:** Skills, database credentials, and MCP servers are mapped strictly to specific domains (e.g., `devops`, `legal`, `finance_real_estate`, `childcare_operations`).
- **Access Trapping:** If an agent operating in the `finance` room attempts to invoke tools or read files mapped to the `legal` room, Harbor traps the call, logs an audit violation, and blocks execution.
- **Sub-Millisecond Token Budgeting:** Token limits are checked and debited via in-process memory hooks ($<1\text{ms}$), stopping runaway recursive loops before they incur excessive API costs.

### 4. Neural Context Compactor (`harbor/bin/harbor-compactor.py`)
Long-running agent sessions naturally exhaust context windows. Traditional summarization models often drop critical architectural constraints or code details.
- **Salience-Weighted Eviction:** Harbor’s compactor scores conversational turns using neural salience (`/v1/salience`).
- **Semantic Anchor Retention:** Preserves original problem definitions, core design decisions, and active test failures while evicting repetitive tool outputs and verbose stack traces.
- **Eviction Archive:** Evicted turns are stored in a structured JSONL archive on disk (`archive/`), ensuring zero information is permanently lost.

### 5. Universal Agent Compatibility
Harbor exposes an in-process Model Context Protocol (MCP) server that connects seamlessly to every major AI engineering tool:

| Agent | Integration Mode | Configuration Command |
| :--- | :--- | :--- |
| **Claude Code** | Stdio MCP Server | `harbor install --for claude-code --write` |
| **Cursor IDE** | Stdio MCP Server | `harbor install --for cursor --write` |
| **Google Antigravity** | Dedicated AGY MCP | `harbor install --for antigravity --write` |
| **OpenCode** | Stdio MCP Server | `harbor install --for opencode --write` |
| **Codex CLI** | Stdio MCP Server | `harbor install --for codex --write` |
| **Goose CLI** | Extension Bridge | `harbor install --for goose --write` |
| **Pi Coding Agent** | Scoped Runtime Integration | `harbor install --for pi --write` |

---

## 💻 Quickstart & Setup

### 1. Initialize the Environment
```bash
# Seed agent_map.md and generate AI beacons (AGENTS.md, CLAUDE.md, .cursorrules)
harbor init

# Build directory tree and configure rooms
harbor setup

# Read-only health check
harbor check
```

### 2. Start the System One Neural Daemon
```bash
# Local development (macOS / Apple Silicon MPS)
cd harbor/services/system_one
uvicorn app:app --host 127.0.0.1 --port 8000

# Docker deployment (Hostinger VPS / Linux CPU)
docker compose up -d
```

### 3. Wire Up Your Coding Agent
```bash
# Inspect generated configuration (safe dry-run)
harbor install --for claude-code

# Apply configuration with automatic backup
harbor install --for claude-code --write
```

---

## ⚡ CLI Command Reference

```bash
harbor search_skills "postgres"     # Query skill catalog via semantic search
harbor activate_skill <skill_name>  # Dynamically load skill into active agent turn
harbor list_rooms                   # List active domain rooms and assigned capabilities
harbor budget_status                # View real-time token spend and session caps
harbor compact                      # Trigger neural context compaction on active session
```

---

## 📄 License & Attribution

Copyright © 2026 TDH Labs / Vibherpunk. All rights reserved.  
Harbor core hypervisor and System One neural routing algorithms are engineered for sovereign, high-velocity autonomous agent infrastructure.
