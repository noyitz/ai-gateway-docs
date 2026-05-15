# Responses API — Overview and Landscape

**Date:** May 15, 2026
**Author:** Noy Itzikowitz
**Status:** Draft

---

## Executive Summary

The Responses API (`POST /v1/responses`) is OpenAI's successor to Chat Completions. It adds server-side statefulness (`previous_response_id`), built-in tools (web search, file search, code interpreter), MCP server integration, and a server-side agentic loop. The [Open Responses specification](https://www.openresponses.org/) is emerging as the industry standard, backed by OpenAI, Hugging Face, vLLM, Ollama, and others.

Our AI Inference Gateway must support Responses API alongside Chat Completions. The core challenge is that Responses API introduces two fundamentally different traffic patterns:

1. **Stateless pass-through** (single inference call) -- similar to Chat Completions today
2. **Stateful agentic loop** (N inference calls, tool execution, state management) -- fundamentally new

The agreed architecture splits responsibility across components:

| Layer | Component | Responsibility |
|-------|-----------|---------------|
| **Inference** | vLLM core / llm-d | Stateless Responses API (pure inference, no state) |
| **Orchestration** | Praxis + vLLM Agentic API | Stateful agentic loop, tool execution, guardrails |
| **State Services** | OGX | Files, Vector Stores, Conversations, Search |
| **Gateway** | IPP (today) / Praxis (future) | Auth, rate limiting, model routing, API translation (external only) |
| **Platform** | MaaS | API keys, subscriptions, model catalog, multi-tenancy |

**The cardinal rule:** For internal models on vLLM/llm-d, there must be **zero API translation** in the inference path. Full fidelity between client and inference server. The gateway layers on stateful features without changing the inference shape.

---

## What is the Responses API?

The Responses API is a superset of Chat Completions that adds:

| Feature | Chat Completions | Responses API |
|---------|-----------------|---------------|
| **State** | Stateless (client sends full history) | Stateful (`previous_response_id`, server stores context) |
| **Tools** | Client-managed function calling only | Built-in server-side tools + MCP + custom functions |
| **Agent loop** | Client orchestrates tool-call cycle | Server-side agentic loop (built-in tools auto-execute) |
| **Reasoning** | Dropped between calls | Preserved via stored/encrypted reasoning items |
| **Input** | `messages`: array of `{role, content}` | `input`: string or array; separate `instructions` field for system prompt |
| **Output** | Single message | Array of typed Items (message, reasoning, tool_call, etc.) |
| **Streaming** | Token deltas | 23+ semantic event types with lifecycle tracking |

### Input Format Difference

**Chat Completions** requires structured messages with roles:
```json
{"model": "gpt-4", "messages": [{"role": "system", "content": "..."}, {"role": "user", "content": "Hello"}]}
```

**Responses API** accepts a simple string or array, with system prompt separated:
```json
{"model": "gpt-4", "instructions": "...", "input": "Hello"}
```

### Statefulness: Hydrate and Dehydrate

- **Hydrate:** The client sends `previous_response_id`. The server looks up the full conversation history (all messages, tool calls, reasoning items) and expands it into the complete context the model needs.
- **Dehydrate:** After the model responds, the server persists the full response into its store and returns a compact response with a new `response_id`. The client doesn't carry full history — just the ID.

### Key Use Cases

Agentic workflows, server-side RAG, code execution agents, MCP-connected applications, long-running background tasks, multi-turn reasoning with state preservation.

### Industry Adoption

OpenAI native. Open Responses spec partners: Hugging Face, Vercel, OpenRouter, LM Studio, Ollama, vLLM. Notably absent: Anthropic, Google (own agent SDKs).

---

## Project Map and Maturity

### Core Infrastructure (Our Stack)

| Project | Repo | Language | Maturity | What It Does |
|---------|------|----------|----------|-------------|
| **IPP (new upstream)** | `llm-d/llm-d-inference-payload-processor` | Go | Early (Apr 2026, no releases) | Envoy ext_proc for payload processing. Plugin framework with CycleState. |
| **IPP (old upstream)** | `kubernetes-sigs/gateway-api-inference-extension` | Go | GA (v1.5.0) | Original home of BBR/EPP. BBR code migrated to new repo. |
| **IPP plugins (downstream)** | `opendatahub-io/ai-gateway-payload-processing` | Go | Active (273 PRs, 97/97 E2E) | 5 production plugins. Still on old upstream dependency. |
| **MaaS** | `opendatahub-io/models-as-a-service` | Go | Pre-GA (v0.1.1) | K8s platform: auth, rate limiting, API keys, model catalog. |
| **Praxis** | `praxis-proxy/praxis` | Rust | Early (v0.3.1) | AI-native proxy with StreamBuffer, re-entrant filter chains, MCP classifier. |

### Ecosystem (Community Projects)

| Project | Repo | Language | Maturity | What It Does |
|---------|------|----------|----------|-------------|
| **vLLM core** | `vllm-project/vllm` | Python/C++ | Production (50K+ stars) | Leading inference engine. Stateless Responses API merged (Jul 2025). |
| **vLLM Agentic API** | `vllm-project/agentic-api` | Rust (migrating) | Pre-MVP (2 months) | Stateful gateway for vLLM: response store, agentic loop, tool execution. |
| **OGX** (formerly LlamaStack) | `ogx-ai/ogx` | Python | Production (8.4K stars, 2 years) | Full agentic API server. Files, Vector Stores, Conversations, Safety. 23 providers. Open Responses conformant. |
| **Open Responses** | `openresponses/openresponses` | Spec | Early | Emerging standard for Responses API. Items, events, tool taxonomy, agentic loop phases. |

### Maturity Assessment

```
Production-Ready    ██████████████████████████████  vLLM core (inference)
                    ██████████████████████████████  OGX (agentic server)

Active/Functional   ████████████████████░░░░░░░░░░  IPP plugins (downstream)
                    ████████████████░░░░░░░░░░░░░░  MaaS
                    ██████████████░░░░░░░░░░░░░░░░  IPP (new upstream)

Early/Rapid Dev     ████████░░░░░░░░░░░░░░░░░░░░░░  Praxis
                    ██████░░░░░░░░░░░░░░░░░░░░░░░░  vLLM Agentic API

Spec/Design         ████░░░░░░░░░░░░░░░░░░░░░░░░░░  Open Responses
```
