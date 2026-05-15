# Responses API Architecture Plan for AI Inference Gateway

**Date:** May 15, 2026
**Author:** Noy Itzikowitz
**Status:** Draft -- post-sync alignment document
**Meeting reference:** Responses API Sync, May 15, 2026

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Landscape Analysis](#2-landscape-analysis)
   - [What is the Responses API?](#21-what-is-the-responses-api)
   - [Project Map and Maturity](#22-project-map-and-maturity)
3. [Meeting Decisions and Agreements](#3-meeting-decisions-and-agreements-may-15-2026)
4. [Component Responsibilities](#4-component-responsibilities)
5. [Request Flow Diagrams](#5-request-flow-diagrams)
6. [Plugin Pipeline Design](#6-plugin-pipeline-design)
7. [Short-Term Plan (0-4 months)](#7-short-term-plan-0-4-months)
8. [Long-Term Plan (6-18 months)](#8-long-term-plan-6-18-months)
9. [Where to Write the Code](#9-where-to-write-the-code)
10. [Open Questions and Risks](#10-open-questions-and-risks)
11. [Appendix: Research Sources](#11-appendix-research-sources)

---

## 1. Executive Summary

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

## 2. Landscape Analysis

### 2.1 What is the Responses API?

The Responses API is a superset of Chat Completions that adds:

| Feature | Chat Completions | Responses API |
|---------|-----------------|---------------|
| **State** | Stateless (client sends full history) | Stateful (`previous_response_id`, server stores context) |
| **Tools** | Client-managed function calling only | Built-in server-side tools + MCP + custom functions |
| **Agent loop** | Client orchestrates tool-call cycle | Server-side agentic loop (built-in tools auto-execute) |
| **Reasoning** | Dropped between calls | Preserved via stored/encrypted reasoning items |
| **Input** | Array of messages with roles | String or messages; separate `instructions` field |
| **Output** | Single message | Array of typed Items (message, reasoning, tool_call, etc.) |
| **Streaming** | Token deltas | 23+ semantic event types with lifecycle tracking |

**Key use cases:** Agentic workflows, server-side RAG, code execution agents, MCP-connected applications, long-running background tasks, multi-turn reasoning with state preservation.

**Industry adoption:** OpenAI native. Open Responses spec partners: Hugging Face, Vercel, OpenRouter, LM Studio, Ollama, vLLM. Notably absent: Anthropic, Google (own agent SDKs).

### 2.2 Project Map and Maturity

#### Core Infrastructure (Our Stack)

| Project | Repo | Language | Maturity | Stars | What It Does |
|---------|------|----------|----------|-------|-------------|
| **IPP (new upstream)** | `llm-d/llm-d-inference-payload-processor` | Go | Early (created Apr 2026, no releases) | 7 | Envoy ext_proc for payload processing. Plugin framework with CycleState. |
| **IPP (old upstream)** | `kubernetes-sigs/gateway-api-inference-extension` | Go | GA (v1.5.0) | 668 | Original home of BBR/EPP. BBR code migrated to new repo. |
| **IPP plugins (downstream)** | `opendatahub-io/ai-gateway-payload-processing` | Go | Active (273 PRs, 97/97 E2E tests) | 5 | 5 production plugins: model-provider-resolver, api-translation, apikey-injection, nemo-guards. Still on old upstream dependency. |
| **MaaS** | `opendatahub-io/models-as-a-service` | Go | Pre-GA (v0.1.1) | 24 | K8s platform for model access: auth, rate limiting, API keys, model catalog. CRDs: Tenant, MaaSModelRef, ExternalModel, MaaSAuthPolicy, MaaSSubscription. |
| **Praxis** | `praxis-proxy/praxis` | Rust | Early (v0.3.1, 6 weeks old) | 23 | AI-native proxy with inline body inspection (StreamBuffer), re-entrant filter chains for agentic loops, MCP classifier. Single-binary replacement for Envoy + ext_proc. |

#### Ecosystem (Community Projects)

| Project | Repo | Language | Maturity | Stars | What It Does |
|---------|------|----------|----------|-------|-------------|
| **vLLM core** | `vllm-project/vllm` | Python/C++ | Production | 50K+ | Leading inference engine. Stateless Responses API merged (Jul 2025). Tool calling WIP. |
| **vLLM Agentic API** | `vllm-project/agentic-api` | Rust (migrating from Python) | Pre-MVP (2 months old) | 26 | Stateful gateway for vLLM: response store, agentic loop, tool execution. Actively debating Rust vs Python. PR #27 proposes Praxis-based architecture. |
| **OGX** (formerly LlamaStack) | `ogx-ai/ogx` | Python | Production (2 years) | 8.4K | Full agentic API server. Files, Vector Stores, Conversations, Safety, Eval. 23 inference providers. Open Responses conformant. |
| **Open Responses** | `openresponses/openresponses` | Spec | Early | - | The emerging standard for Responses API. Defines items, events, tool taxonomy, agentic loop phases. |

#### Maturity Assessment

```
Production-Ready    ██████████████████████████████  vLLM core (inference)
                    ██████████████████████████████  OGX (agentic server)

Active/Functional   ████████████████████░░░░░░░░░░  IPP plugins (downstream)
                    ████████████████░░░░░░░░░░░░░░  MaaS
                    ██████████████░░░░░░░░░░░░░░░░  IPP (new upstream)

Early/Rapid Dev     ████████░░░░░░░░░░░░░░░░░░░░░░  Praxis
                    ██████░░░░░░░░░░░░░░░░░░░░░░░░  vLLM Agentic API

Spec/Design         ████░░░░░░░░░░░░░░░░░░░░░░░░░░  Open Responses
                    ████░░░░░░░░░░░░░░░░░░░░░░░░░░  Dzonca's RFC/Plugin Catalog
```

---

## 3. Meeting Decisions and Agreements (May 15, 2026)

These were explicitly agreed upon during the sync:

### Architecture Split

1. **vLLM core** will implement a **stateless** Responses API (pure inference shape, no state management, no tool execution)
2. **vLLM Agentic API** will implement the **stateful** Responses API (agentic loop, tool calling, state)
3. **OGX** should handle state management: Files, Vector Stores, Search, Conversations
4. **Praxis** is a more AI-native proxy with better abstractions than Envoy ext_proc (payload processing, plugin execution, re-entrant loops)

### Two Distinct Pathways

5. **Internal models (open-weight on vLLM/llm-d):** NO API translation. Full fidelity pass-through. Gateway adds stateful features as a layer on top without changing the inference shape.
6. **External models (SaaS providers):** API translation remains necessary. Different chain of plugins for auth, key injection, format conversion.

### Guardrails

7. Guardrails are **not** transparent inference proxies. They are separate endpoints that receive the payload explicitly. They must understand the Responses API format natively (not via translation to Chat Completions).
8. Input guardrails work on user messages (similar to today). Output guardrails on model responses are harder -- if the guardrail doesn't understand Responses format natively, it creates issues.

### Where to Write Code

9. **Depend on Praxis** in agentic APIs (use Praxis as core layer)
10. **Depend on OGX** in agentic APIs for DB/state services (or make it pluggable)
11. Code goes into **agentic-apis/fork** and other logic areas where rational
12. Wait a few days before kicking off so others can weigh in

### Open Items

13. **ITS (Intelligent Ticket System)** -- raised during sync, needs team alignment
14. A roadmap for the gateway piece is needed
15. A Dev channel for gateway coordination will be created
16. Follow-up needed with customers on Responses API interest

---

## 4. Component Responsibilities

### vLLM Core (Stateless Inference)

| Responsibility | Details |
|---------------|---------|
| Stateless Responses API | Accept `/v1/responses` requests, produce responses with Items. No state management. |
| Chat Completions | Existing `/v1/chat/completions` continues unchanged. |
| Messages API | Existing `/v1/messages` continues unchanged. |
| Token generation | Core competency: fast, efficient inference with KV-cache, speculative decoding, etc. |
| **NOT responsible for** | State storage, agentic loops, tool execution, conversation history, file/vector stores. |

### vLLM Agentic API / Praxis (Stateful Orchestration)

| Responsibility | Details |
|---------------|---------|
| Agentic loop | Orchestrate multi-turn tool-calling loops within a single request lifecycle. |
| State management | Response store (previous_response_id), conversation context. |
| Tool execution | Server-side tools (web search, file search, code interpreter) and MCP tool discovery/execution. |
| Guardrails (within loop) | Input/output content safety checks per loop iteration. |
| Context hydration | Resolve `previous_response_id`, load conversation history, inject into inference request. |
| SSE streaming | Produce semantic Responses API events (23+ types) from inference stream. |
| **NOT responsible for** | Token generation, model weights, KV-cache management. |

### OGX (State Services)

| Responsibility | Details |
|---------------|---------|
| Files API | `POST /v1/files`, file upload, chunking, storage. |
| Vector Stores | `POST /v1/vector_stores`, embedding, indexing, semantic search. |
| Conversations | Durable conversation objects, item storage, cross-session persistence. |
| Search | Retrieval over vector stores (file_search tool backend). |
| Batches | Offline batch processing for large workloads. |
| **NOT responsible for** | Inference, agentic loop orchestration, model routing. |

### IPP / Payload Processor (Gateway Plugins)

| Responsibility | Details |
|---------------|---------|
| Auth (external models) | Validate API keys, inject provider credentials. |
| Rate limiting | Token-based quota enforcement per subscription. |
| Model routing | Resolve model name → provider + endpoint via ExternalModel CRD. |
| API translation | Convert between OpenAI ↔ provider-native formats (external models ONLY). |
| Guardrails (intake) | Pre-inference content safety (NeMo guardrails). |
| **NOT responsible for** | Agentic loops, state management, tool execution. For internal models, NOT responsible for any API translation. |

### MaaS (Platform Layer)

| Responsibility | Details |
|---------------|---------|
| API key management | Minting, validation, hash storage of `sk-oai-*` keys. |
| Subscriptions & quotas | Token-based rate limits per user/group/model. |
| Model catalog | Unified `/v1/models` across internal and external models. |
| Auth policies | Who can access which models (MaaSAuthPolicy CRD). |
| Tenant management | Platform-level configuration. |
| **NOT responsible for** | Request payload processing, agentic loops, inference. |

### Praxis (Future Proxy Layer)

| Responsibility | Details |
|---------------|---------|
| Proxy & routing | Replace Envoy/Istio data plane for AI traffic. |
| Inline body inspection | StreamBuffer for model name extraction, protocol detection (no ext_proc roundtrip). |
| Re-entrant loops | Branch chains for agentic loop orchestration within the proxy. |
| Plugin execution | Run Rust filters for auth, rate limiting, guardrails, translation. |
| MCP gateway | Tool catalog, session management, backend registry. |
| **NOT responsible for** | Being a standalone agentic server. Praxis is the runtime; plugins/filters provide the logic. |

---

## 5. Request Flow Diagrams

### Flow 1: Stateless Responses API (Internal Model, Simple Completion)

```mermaid
sequenceDiagram
    actor Client
    participant GW as Gateway<br/>(Istio/Praxis)
    participant MaaS as MaaS API
    participant IPP as IPP Intake<br/>Plugins
    participant vLLM as vLLM / llm-d

    Client->>GW: POST /v1/responses<br/>{model:"llama-4", input:"Hello"}
    GW->>MaaS: Validate API key
    MaaS-->>GW: OK (key valid, subscription matched)
    GW->>IPP: request-validator, rate-limit check
    IPP-->>GW: OK (within quota)

    Note over GW,vLLM: PASS-THROUGH — no translation for internal models

    GW->>vLLM: POST /v1/responses (unchanged payload)
    vLLM-->>GW: SSE stream
    GW-->>Client: SSE: response.created
    GW-->>Client: SSE: output_text.delta (tokens...)
    GW-->>Client: SSE: response.completed
```

### Flow 2: Stateful Agentic Loop (Internal Model, MCP Tools)

```mermaid
sequenceDiagram
    actor Client
    participant GW as Gateway<br/>(Istio/Praxis)
    participant MaaS as MaaS API
    participant IPP as IPP Intake<br/>Plugins
    participant AL as Agentic Loop<br/>(Praxis / Agentic API)
    participant OGX as OGX<br/>(State Services)
    participant MCP as MCP Server
    participant Guards as Guardrails<br/>Service
    participant vLLM as vLLM / llm-d

    Client->>GW: POST /v1/responses<br/>{model:"llama-4", input:"Search for...",<br/>tools:[{type:"mcp"}],<br/>previous_response_id:"resp_abc123"}

    GW->>MaaS: Validate API key
    MaaS-->>GW: OK

    GW->>IPP: request-validator, rate-limit, model-resolver
    IPP-->>GW: OK (internal model detected)

    GW->>AL: Forward to Agentic Loop

    AL->>OGX: Hydrate previous_response_id → full conversation history
    OGX-->>AL: Conversation context + previous items

    AL->>MCP: tools/list (discover available tools)
    MCP-->>AL: Tool catalog

    AL->>Guards: Input guardrails check
    Guards-->>AL: OK

    rect rgb(30, 50, 30)
        Note over AL,vLLM: LOOP ITERATION 1
        AL->>vLLM: POST /v1/responses (hydrated, no translation)
        vLLM-->>AL: Response with tool_call item
        AL->>Guards: Output guardrails check
        Guards-->>AL: OK
        AL->>MCP: Execute tool call
        MCP-->>AL: Tool result
    end

    rect rgb(30, 50, 30)
        Note over AL,vLLM: LOOP ITERATION 2
        AL->>vLLM: POST /v1/responses (with tool result injected)
        vLLM-->>AL: Final text response (no more tool calls)
    end

    AL->>OGX: Persist response + conversation state
    AL-->>Client: SSE: response.created, output items, response.completed
```

### Flow 3: External Model (SaaS Provider, Chat Completions Translation)

```mermaid
sequenceDiagram
    actor Client
    participant GW as Gateway<br/>(Istio/Praxis)
    participant MaaS as MaaS API
    participant IPP as IPP Pipeline
    participant Provider as External Provider<br/>(OpenAI / Anthropic / Azure / etc.)

    Client->>GW: POST /v1/chat/completions<br/>{model:"gpt-4", messages:[...]}
    GW->>MaaS: Validate API key
    MaaS-->>GW: OK

    GW->>IPP: model-provider-resolver
    Note over IPP: Lookup ExternalModel CRD<br/>→ resolve provider, endpoint, credentials

    IPP->>IPP: api-translation (request)<br/>OpenAI → provider-native format
    IPP->>IPP: apikey-injection<br/>Inject provider credentials from K8s Secret

    IPP->>Provider: Translated request<br/>(provider-native format + auth headers)
    Provider-->>IPP: Provider-native response

    IPP->>IPP: api-translation (response)<br/>Provider-native → OpenAI format

    IPP-->>Client: OpenAI-format response
```

### Flow 4: Stateful Agentic Loop (External Model, MCP Tools)

This flow is more complex than the internal model agentic loop because each inference iteration requires API translation.

```mermaid
sequenceDiagram
    actor Client
    participant GW as Gateway<br/>(Istio/Praxis)
    participant MaaS as MaaS API
    participant IPP as IPP Plugins
    participant AL as Agentic Loop<br/>(Praxis / Agentic API)
    participant OGX as OGX<br/>(State Services)
    participant MCP as MCP Server
    participant Guards as Guardrails<br/>Service
    participant Provider as External Provider<br/>(OpenAI / Anthropic / etc.)

    Client->>GW: POST /v1/responses<br/>{model:"gpt-4", input:"Search for...",<br/>tools:[{type:"mcp"}],<br/>previous_response_id:"resp_abc123"}

    GW->>MaaS: Validate API key
    MaaS-->>GW: OK

    GW->>IPP: request-validator, rate-limit, model-provider-resolver
    Note over IPP: ExternalModel CRD lookup<br/>→ resolve provider, endpoint, credentials

    IPP->>AL: Forward to Agentic Loop<br/>(with provider info in CycleState)

    AL->>OGX: Hydrate previous_response_id
    OGX-->>AL: Conversation context

    AL->>MCP: tools/list (discover tools)
    MCP-->>AL: Tool catalog

    AL->>Guards: Input guardrails check
    Guards-->>AL: OK

    rect rgb(50, 30, 30)
        Note over AL,Provider: LOOP ITERATION 1 (with API translation)
        AL->>IPP: api-translation (Responses → Chat Completions)
        IPP->>IPP: apikey-injection
        IPP->>Provider: Translated request + provider auth
        Provider-->>IPP: Provider-native response
        IPP->>AL: api-translation (response → OpenAI format)
        AL->>Guards: Output guardrails check
        Guards-->>AL: OK
        Note over AL: tool_call detected
        AL->>MCP: Execute tool call
        MCP-->>AL: Tool result
    end

    rect rgb(50, 30, 30)
        Note over AL,Provider: LOOP ITERATION 2 (with tool result)
        AL->>IPP: api-translation (with tool result injected)
        IPP->>Provider: Translated request
        Provider-->>AL: Final text response (no more tool calls)
    end

    AL->>OGX: Persist response + conversation state
    AL-->>Client: SSE: response.created, output items, response.completed
```

**Key difference from internal model flow:** Each loop iteration goes through the IPP `api-translation` and `apikey-injection` plugins because the external provider speaks a different API format. This adds latency per iteration and is inherently lossy (reasoning items, Items array structure may not translate perfectly). For this reason, the agentic loop with external models is a lower-fidelity experience than with internal models.

---

## 6. Plugin Pipeline Design

Based on the unified plugin catalog RFC, the target architecture defines a **20-plugin pipeline** that handles both Chat Completions and Responses API through the same chain with conditional execution.

### Unified Pipeline (Target State)

```
                    ┌─── INTAKE (runs once) ───────────────────────┐
                    │                                              │
                    │  1. auth                    [Exists in IPP]  │
                    │  2. rate-limit (check)      [Exists in IPP]  │
                    │  3. request-validator        [Extends IPP]   │
                    │  4. hydrate-prompt           [NEW]           │
                    │  5. conversation-manager     [NEW]           │
                    │  6. tool-registry            [NEW]           │
                    │  7. guardrails (input)       [Extends IPP]   │
                    │  8. model-provider-resolver  [Exists in IPP] │
                    │                                              │
                    └──────────────────────────────────────────────┘
                                         │
                                         ▼
                    ┌─── INFERENCE LOOP (iterates for Responses) ──┐
                    │                                              │
                    │  9. api-translation (req)   [Extends IPP]   │
                    │ 10. body-field-to-header    [Exists in IPP]  │
                    │ 11. base-model-to-header    [Exists in IPP]  │
                    │ 12. apikey-injection        [Exists in IPP]  │
                    │          ┌──── MODEL CALL ────┐              │
                    │ 13. inference-caller         [NEW]           │
                    │          └────────────────────┘              │
                    │ 14. api-translation (resp)  [Extends IPP]   │
                    │ 15. guardrails (output)     [Extends IPP]   │
                    │ 16. rate-limit (usage)      [Exists in IPP] │
                    │ 17. tool-call-handler        [NEW]           │
                    │ 18. loop-controller          [NEW]           │
                    │ 19. server-tool-executor     [NEW]           │
                    │ 20. mcp-executor             [NEW]           │
                    │                                              │
                    │         ──── LOOP BACK to #9 ────           │
                    └──────────────────────────────────────────────┘
                                         │
                                         ▼
                    ┌─── COMPLETION (Responses only) ──────────────┐
                    │                                              │
                    │ 21. response-assembler       [NEW]           │
                    │ 22. response-store           [NEW]           │
                    │ 23. conversation-manager     [NEW] (save)    │
                    │                                              │
                    └──────────────────────────────────────────────┘
```

### Plugin Classification

| # | Plugin | Boundary | IPP Status | OGX (LlamaStack) | vLLM Agentic API | Reuse Strategy |
|---|--------|----------|------------|-------------------|------------------|----------------|
| 1 | auth | External | Exists | Auth middleware | -- | Keep IPP |
| 2 | rate-limit | External | Exists | -- | -- | Keep IPP |
| 3 | request-validator | Local | Extends | Request validation | -- | Extend IPP |
| 4 | hydrate-prompt | External | -- | **Exists** (prompt hydration + templates) | In ADR-01 scope | Reuse OGX |
| 5 | conversation-manager | External | -- | **Exists** (Conversations API, dual storage) | In ADR-02 (response store) | Reuse OGX |
| 6 | tool-registry | External | -- | **Exists** (ToolRuntime + MCP discovery) | In MVP scope | Reuse OGX |
| 7 | guardrails | External | Extends | **Exists** (Shield-based safety, Moderation) | -- | Extend IPP + call OGX/NeMo |
| 8 | model-provider-resolver | External | Exists | **Exists** (RoutingTable, 23 providers) | -- | Keep IPP (K8s-native CRDs) |
| 9 | api-translation | Local | Extends | **Exists** (multi-SDK: OpenAI, Anthropic, Google) | -- | Extend IPP (ext models only) |
| 10 | body-field-to-header | Local | Exists | -- | -- | Keep IPP |
| 11 | base-model-to-header | External | Exists | -- | -- | Keep IPP |
| 12 | apikey-injection | External | Exists | -- | -- | Keep IPP |
| 13 | inference-caller | External | -- | **Exists** (Orchestrator → Inference actor) | Planned (httpx forwarding) | Reuse OGX/Agentic API |
| 14 | tool-call-handler | Local | -- | **Exists** (Executor actor, tool dispatch) | -- | Reuse OGX |
| 15 | loop-controller | Local | -- | **Exists** (Orchestrator streaming loop) | -- | Reuse OGX |
| 16 | server-tool-executor | External | -- | **Exists** (ToolRuntime: web_search, code_interpreter) | -- | Reuse OGX |
| 17 | host-tool-executor | Sandboxed | -- | **Exists** (code_interpreter sandbox) | -- | Reuse OGX |
| 18 | mcp-executor | External | -- | **Exists** (MCP actor) | -- | Reuse OGX |
| 19 | response-assembler | Local | -- | **Exists** (response construction) | -- | Reuse OGX |
| 20 | response-store | External | -- | **Exists** (Store + Conversations dual persistence) | In ADR-02 (SQLite 3-table) | Reuse OGX / Agentic API |

**Summary:**
- **7 plugins** exist in IPP today (keep or extend)
- **11 plugins** have implementations in OGX that we can reuse as external service calls
- **2 plugins** are being built in vLLM Agentic API (response store, tool registry)
- **Reuse strategy:** For the agentic loop plugins (4-6, 13-20), call OGX as an external service rather than reimplementing. Long-term, these may be rewritten as Praxis Rust filters, but OGX provides working implementations today.

### Conditional Execution

For Chat Completions requests, plugins 4-6, 13-15, 17-20 are **skipped** (no agentic loop, no response store). The pipeline collapses to the existing IPP flow. The `request-validator` plugin detects the API type and sets a CycleState flag that gates downstream execution.

For internal models, plugins 9 (api-translation req), 12 (apikey-injection), and 14 (api-translation resp) are **skipped** or become no-ops (pass-through). No translation for native vLLM/llm-d Responses API.

---

## 7. Short-Term Plan (0-4 months)

### Phase 1: Foundation (Weeks 1-4)

**Goal:** Stateless Responses API pass-through for internal models. No agentic loop yet.

```
  Client
    │
    ▼
┌──────────────────────────────────────────────────┐
│              AI Inference Gateway                 │
│                                                  │
│  ┌──────────────┐   ┌────────────────────────┐   │
│  │ Istio/Envoy  │──▶│ MaaS API               │   │
│  │ (proxy)      │   │ (auth, rate limiting)   │   │
│  └──────────────┘   │ 🆕 /v1/responses route  │   │
│                     └───────────┬────────────┘   │
│                                 │                │
│                                 ▼                │
│  ┌──────────────────────────────────────────┐    │
│  │ IPP Plugins (Go ext_proc)                │    │
│  │                                          │    │
│  │  🆕 request-validator                    │    │
│  │  body-field-to-header (existing)         │    │
│  │  base-model-to-header (existing)         │    │
│  └─────────────────┬────────────────────────┘    │
│                    │                             │
│      ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░       │
│      ░ NOT YET: api-translation (Phase 2) ░       │
│      ░ NOT YET: Agentic Loop    (Phase 3) ░       │
│      ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░       │
│                    │                             │
└────────────────────┼─────────────────────────────┘
                     │ PASS-THROUGH (no translation)
                     ▼
            ┌────────────────┐
            │ vLLM / llm-d   │
            │ (stateless     │
            │ /v1/responses) │
            └────────────────┘
```

**What each component does in Phase 1:**

| Component | Responsibility | Status |
|-----------|---------------|--------|
| **Istio/Envoy** | Proxy, TLS termination, routing | Existing, unchanged |
| **MaaS API** | API key validation, rate limiting, `/v1/responses` HTTPRoute | 🆕 Add HTTPRoute for `/v1/responses` |
| **IPP: request-validator** | Detect Responses vs Chat Completions format, set CycleState flag | 🆕 New plugin |
| **IPP: existing plugins** | body-field-to-header, base-model-to-header | Existing, unchanged |
| **vLLM / llm-d** | Stateless `/v1/responses` endpoint (no state, no tools) | Existing (merged Jul 2025) |

| Task | Where |
|------|-------|
| Add `/v1/responses` route to MaaS HTTPRoute generation | `models-as-a-service` |
| Request-validator plugin: detect Responses vs Chat Completions format | `ai-gateway-payload-processing` |
| Stateless pass-through: forward `/v1/responses` to vLLM with zero translation | `ai-gateway-payload-processing` |
| SSE streaming pass-through: ensure gateway doesn't break semantic events | `ai-gateway-payload-processing` |
| E2E: verify vLLM's stateless Responses API works through the gateway | E2E tests |

**Deliverable:** A client can send `POST /v1/responses` to the AI Gateway, it passes through MaaS auth/RL, and reaches vLLM unchanged. Response streams back with full fidelity.

---

### Phase 2: External Model Support (Weeks 4-8)

**Goal:** Responses API support for external models via translation to Chat Completions.

```
  Client
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│                    AI Inference Gateway                       │
│                                                              │
│  ┌──────────────┐   ┌──────────────────┐                    │
│  │ Istio/Envoy  │──▶│ MaaS API         │                    │
│  │ (proxy)      │   │ (auth, rate lim) │                    │
│  └──────────────┘   └────────┬─────────┘                    │
│                              │                              │
│                              ▼                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ IPP Plugins (Go ext_proc)                            │   │
│  │                                                      │   │
│  │  request-validator                                   │   │
│  │  model-provider-resolver (ExternalModel CRD)         │   │
│  │  🆕 api-translation (Responses ↔ Chat Completions)   │   │
│  │  apikey-injection                                    │   │
│  │  🆕 guardrails (Responses API format)                │   │
│  └──────────┬───────────────────────┬───────────────────┘   │
│             │                       │                       │
│      ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░                 │
│      ░ NOT YET: Agentic Loop (Phase 3)    ░                 │
│      ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░                 │
│             │                       │                       │
└─────────────┼───────────────────────┼───────────────────────┘
              │                       │
    internal  │              external │ (translated)
    (no xlat) │                       │
              ▼                       ▼
     ┌────────────────┐    ┌─────────────────────┐
     │ vLLM / llm-d   │    │ External Providers   │
     │ (pass-through) │    │ OpenAI, Anthropic,   │
     └────────────────┘    │ Azure, Bedrock,      │
                           │ Vertex               │
                           └─────────────────────┘
```

**What each component does in Phase 2:**

| Component | Responsibility | Status |
|-----------|---------------|--------|
| **IPP: api-translation** | Bidirectional Responses API ↔ Chat Completions translation for all 5 external providers | 🆕 Extend existing plugin |
| **IPP: guardrails** | Parse Responses API input format for NeMo guardrails | 🆕 Extend existing plugin |
| **IPP: model-provider-resolver** | Route to internal (pass-through) vs external (translate) path | Existing, unchanged |
| **IPP: apikey-injection** | Inject provider credentials | Existing, unchanged |
| **vLLM / llm-d** | Internal models: pass-through | Existing |
| **External providers** | All 5 providers via translated Chat Completions | Existing |

| Task | Where |
|------|-------|
| Extend api-translation: Responses API → Chat Completions for external providers | `ai-gateway-payload-processing` |
| Response translation: Chat Completions response → Responses API Items format | `ai-gateway-payload-processing` |
| Decide: support Responses API → OpenAI Responses API (direct, no translation)? | Design decision |
| Guardrails: extend NeMo guards to parse Responses API input format | `ai-gateway-payload-processing` |
| E2E: Responses API tests on all 5 providers | E2E tests |

**Deliverable:** External model users can send Responses API format and get correct responses from all providers.

---

### Phase 3: Agentic Loop Integration (Weeks 8-16)

**Goal:** Integrate OGX-backed agentic loop for internal models with MCP tool support. Most agentic plugins already exist in OGX — this phase is integration, not greenfield.

```
  Client
    │
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       AI Inference Gateway                          │
│                                                                     │
│  ┌──────────────┐   ┌──────────────────┐                           │
│  │ Istio/Envoy  │──▶│ MaaS API         │                           │
│  │ (proxy)      │   │ (auth, rate lim) │                           │
│  └──────────────┘   └────────┬─────────┘                           │
│                              │                                     │
│                              ▼                                     │
│  ┌──────────────────────────────────────────┐                      │
│  │ IPP Intake Plugins (Go ext_proc)         │                      │
│  │  request-validator, model-provider-      │                      │
│  │  resolver, api-translation, apikey-inj   │                      │
│  └──────────┬───────────────────┬───────────┘                      │
│             │ internal+stateful │ external                         │
│             ▼                   ▼                                  │
│  ┌──────────────────────────────────────────┐   ┌───────────────┐ │
│  │ 🆕 Agentic Loop                          │   │ External      │ │
│  │    (Praxis / vLLM Agentic API)           │   │ Providers     │ │
│  │                                          │   │ (OpenAI,      │ │
│  │  conversation-manager   ◄─ reuse OGX    │   │  Anthropic,   │ │
│  │  tool-registry          ◄─ reuse OGX    │   │  Azure,       │ │
│  │  guardrails (in+out)                    │   │  Bedrock,     │ │
│  │  inference-caller       ◄─ reuse OGX    │   │  Vertex)      │ │
│  │  loop-controller        ◄─ reuse OGX    │   └───────────────┘ │
│  │  mcp-executor           ◄─ reuse OGX    │                     │
│  │  response-store    ◄─ reuse OGX/AgAPI   │                     │
│  └───────┬──────────┬──────────┬────────────┘                     │
│          │          │          │                                   │
│          ▼          ▼          ▼                                   │
│  ┌───────────┐ ┌─────────┐ ┌────────────┐                        │
│  │ OGX       │ │ MCP     │ │ Guardrails │                        │
│  │ (convos,  │ │ Servers │ │ Service    │                        │
│  │  files,   │ │         │ │ (NeMo)     │                        │
│  │  VDB,     │ │         │ │            │                        │
│  │  store)   │ │         │ │            │                        │
│  └───────────┘ └─────────┘ └────────────┘                        │
│                                                                     │
└──────────────────────┬──────────────────────────────────────────────┘
                       │ no translation (internal)
                       ▼
              ┌────────────────┐
              │ vLLM / llm-d   │
              │ (stateless     │
              │ /v1/responses) │
              └────────────────┘
```

**What each component does in Phase 3:**

| Component | Responsibility | Status |
|-----------|---------------|--------|
| **Agentic Loop** | Orchestrate multi-turn tool-calling loops for Responses API requests | 🆕 New component (Praxis-based) |
| **conversation-manager** | Resolve `previous_response_id`, hydrate context, persist after completion | ♻️ Reuse OGX Conversations API |
| **tool-registry** | Discover MCP tools via `tools/list` | ♻️ Reuse OGX ToolRuntime |
| **inference-caller** | Call vLLM's stateless `/v1/responses` with hydrated context | ♻️ Reuse OGX Orchestrator → Inference |
| **loop-controller** | Detect tool calls in response, decide: loop back or complete | ♻️ Reuse OGX Orchestrator streaming loop |
| **mcp-executor** | Execute MCP tool calls, return results to loop | ♻️ Reuse OGX MCP actor |
| **response-store** | Persist responses for `previous_response_id` lookups | ♻️ Reuse OGX Store / Agentic API ADR-02 |
| **OGX** | Backend services: conversations, files, vector stores, response store | ♻️ Deploy existing OGX (production-ready) |
| **MCP Servers** | External tool backends | New integration |
| **IPP intake** | Auth, rate-limit, model-resolver (unchanged from Phase 2) | Existing |

| Task | Where |
|------|-------|
| Deploy OGX as state service backend (conversations, response store) | OGX deployment |
| Wire agentic loop to call OGX APIs for hydration/persistence | `vllm-project/agentic-api` |
| Wire agentic loop to call OGX ToolRuntime + MCP actor for tool execution | `vllm-project/agentic-api` |
| Integrate OGX Orchestrator loop logic (or reimplement thin version in Praxis) | `vllm-project/agentic-api` |
| Contribute to vLLM Agentic API project (Praxis-based architecture) | `vllm-project/agentic-api` |
| Demo: Responses API request with MCP tools, server executes tool loop | Demo |

**Deliverable:** Working POC of agentic loop with MCP tools on internal model, backed by OGX state services.

---

## 8. Long-Term Plan (6-18 months)

### Phase 4: Praxis Migration (Months 6-12)

**Goal:** Replace Envoy + ext_proc with Praxis for AI traffic.

| Task | Where | Owner |
|------|-------|-------|
| Rewrite IPP plugins as Praxis Rust filters | `praxis-proxy/praxis` or downstream | IPP team |
| StreamBuffer body inspection replaces ext_proc gRPC roundtrips | `praxis-proxy/praxis` | Praxis team |
| Re-entrant filter chains for agentic loop orchestration | `praxis-proxy/praxis` | Praxis team |
| Praxis Kubernetes operator integration | `praxis-proxy/operator` | Praxis team |
| Benchmark: Praxis vs Envoy+ext_proc latency comparison | Performance testing | Team |
| Migration path: Praxis as Envoy ext_proc server (intermediate step) | `praxis-proxy/extproc` | Team |

### Phase 5: Full Agentic Platform (Months 9-15)

**Goal:** Production-ready Responses API with full tool support.

| Task | Where | Details |
|------|-------|---------|
| OGX integration for Files/Vector Stores/Conversations | OGX + gateway | Use OGX as state service backend |
| Built-in tools: file_search, web_search, code_interpreter | Agentic loop | Server-side execution |
| Background mode (`background: true`) | Agentic loop | Async worker pool, polling endpoint |
| Function tool round-trip (client-side tools) | Agentic loop | Yield control to client, resume on callback |
| Multi-tenancy for state services | MaaS + OGX | Quota management for Files, Vector Stores |
| Guardrails: native Responses API format (no translation) | Guardrails service | Per-iteration guardrails within loop |

### Phase 6: Unified Gateway (Months 12-18)

**Goal:** Simplified architecture with Praxis as the single proxy + orchestrator.

| Component | Current | Target |
|-----------|---------|--------|
| Proxy | Istio/Envoy | Praxis |
| Body inspection | ext_proc gRPC (Go) | Inline Praxis filters (Rust) |
| Agentic loop | External service | Praxis re-entrant filter chains |
| Plugin system | Go CycleState framework | Rust filter pipeline with branch chains |
| MCP gateway | Not implemented | Praxis built-in (tool catalog, session mgmt) |
| Config | Kuadrant CRDs → AuthPolicy/RateLimitPolicy | Direct Praxis YAML or operator CRDs |

### Target Architecture Diagram (Long-Term)

```
  Client
    │
    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       AI Inference Gateway                          │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                    Praxis Proxy (Rust)                         │ │
│  │                                                               │ │
│  │  ┌─── Intake Filters (run once) ────┐                        │ │
│  │  │  auth                            │                        │ │
│  │  │  rate-limit                      │                        │ │
│  │  │  request-validator               │                        │ │
│  │  │  conversation-manager            │                        │ │
│  │  │  tool-registry                   │                        │ │
│  │  │  model-resolver                  │                        │ │
│  │  └──────────────┬───────────────────┘                        │ │
│  │                 │                                            │ │
│  │                 ▼                                            │ │
│  │  ┌─── Loop Filters (re-entrant) ───┐                        │ │
│  │  │  api-translation (ext only)     │                        │ │
│  │  │  inference-caller          ─────┼───▶ vLLM / Providers   │ │
│  │  │  guardrails                     │                        │ │
│  │  │  tool-call-handler              │                        │ │
│  │  │  loop-controller           ─────┼──╮ loop back           │ │
│  │  │  mcp-executor                   │  │                     │ │
│  │  │  server-tool-executor           │  │                     │ │
│  │  └──────────────┬──────────────────┘  │                     │ │
│  │                 │              ▲───────╯                     │ │
│  │                 ▼                                            │ │
│  │  ┌─── Completion Filters ──────────┐                        │ │
│  │  │  response-assembler             │                        │ │
│  │  │  response-store                 │                        │ │
│  │  └─────────────────────────────────┘                        │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                    │          │          │                          │
│                    ▼          ▼          ▼                          │
│            ┌───────────┐ ┌─────────┐ ┌────────────┐               │
│            │ OGX       │ │ MCP     │ │ Guardrails │               │
│            │ (files,   │ │ Servers │ │ Service    │               │
│            │  VDB,     │ │         │ │            │               │
│            │  convos,  │ │         │ │            │               │
│            │  search)  │ │         │ │            │               │
│            └───────────┘ └─────────┘ └────────────┘               │
│                                                                     │
│            ┌────────────────────────────────────────┐               │
│            │  MaaS API (auth, keys, catalog, quotas) │               │
│            └────────────────────────────────────────┘               │
│                                                                     │
└──────────────────────┬──────────────────────┬───────────────────────┘
                       │                      │
                       ▼                      ▼
         ┌──────────────────────┐   ┌──────────────────┐
         │ vLLM Pods (llm-d)   │   │ External Provider │
         │ Pod A    Pod B      │   │ (OpenAI, etc.)    │
         └──────────────────────┘   └──────────────────┘
```

---

## 9. Where to Write the Code

Based on meeting decisions and architecture analysis:

| What | Where | Why |
|------|-------|-----|
| **Agentic loop core** (orchestration, state, tools) | `vllm-project/agentic-api` (contribute upstream) | Community project; Praxis-based architecture (PR #27). This is the agreed home for stateful orchestration in the vLLM community. |
| **Agentic loop plugins** (Rust filters) | `vllm-project/agentic-api` or Praxis plugins repo | Plugins compiled into Praxis; don't need to live in same repo. |
| **Gateway intake plugins** (auth, RL, model-resolver, api-translation) | `ai-gateway-payload-processing` (short-term, Go) → Praxis filters (long-term, Rust) | Existing plugins work today. Rewrite to Rust when Praxis is ready. |
| **OGX state service integration** | `vllm-project/agentic-api` depends on OGX APIs | OGX provides Files, Vector Stores, Conversations as microservices. |
| **MaaS route support** | `opendatahub-io/models-as-a-service` | HTTPRoute generation for `/v1/responses`. |
| **Praxis core capabilities** | `praxis-proxy/praxis` (contribute upstream) | Re-entrant loops, MCP gateway, sub-requests -- core proxy features. |
| **Guardrails extensions** | `ai-gateway-payload-processing` (short-term) → Praxis filter (long-term) | Extend NeMo guards for Responses API format. |
| **Documentation & visualizer** | `noyitz/ai-gateway-docs` | Flow diagrams, architecture docs, plugin catalog. |
| **E2E tests** | `noyitz/api-tests` + `ai-gateway-payload-processing` E2E suite | Responses API E2E across internal + external models. |

---

## 10. Open Questions and Risks

### Open Questions

1. **Who owns the agentic loop in our product?** The vLLM Agentic API project is community-driven and pre-MVP. If it doesn't mature fast enough, do we build our own orchestration in Praxis plugins?

2. **Praxis maturity risk.** Praxis is 6 weeks old with a small contributor base. The v0.5.0 milestone (Responses API, 158 issues) is due Jul 27. Can it deliver?

3. **OGX dependency.** OGX (formerly LlamaStack) provides state services but it's a Python server. Performance concerns for high-throughput state operations? Do we need a Rust/Go alternative?

4. **Migration from old upstream to new upstream.** The downstream `ai-gateway-payload-processing` still depends on `kubernetes-sigs/gateway-api-inference-extension`. When does it migrate to `llm-d/llm-d-inference-payload-processor`?

5. **Responses API for external models -- how lossy is translation?** The agreed rule is "no translation" for internal models. For external models, Responses → Chat Completions is inherently lossy (reasoning items, items array, semantic streaming). How much do we invest in making this work well vs telling users to use Chat Completions for external models?

6. **Multi-tenancy for state.** MaaS quota management for Files, Vector Stores, etc. How do entitlements work? Who pays for vector store storage?

7. **ITS (Intelligent Ticket System)** -- raised during sync. What is it and how does it fit?

8. **Customer demand.** Need to follow up on customer interest in Responses API. Until we hear back, we're building speculatively.

### Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Praxis doesn't mature fast enough | Stuck on Envoy+ext_proc, can't do re-entrant loops | Keep Go IPP working; Praxis ext_proc bridge as fallback |
| vLLM Agentic API project stalls (Rust vs Python debate) | No community-backed agentic loop | Build in Praxis plugins independently; contribute back later |
| Open Responses spec doesn't get traction | No standard to build against | Build against OpenAI's actual API; spec is a bonus |
| OGX/LlamaStack strategic shift by Meta | State services dependency at risk | Abstract state service interface; allow pluggable backends |
| Guardrails can't handle Responses API natively | Output guardrails break on Items format | Invest in guardrail Responses API support early |
| External model translation is too lossy | Poor UX for SaaS model users | Be transparent about limitations; recommend Chat Completions for external models where fidelity matters |

---

## 11. Appendix: Research Sources

### Repos Analyzed

| Repo | URL |
|------|-----|
| IPP (old upstream) | https://github.com/kubernetes-sigs/gateway-api-inference-extension |
| IPP (new upstream) | https://github.com/llm-d/llm-d-inference-payload-processor |
| IPP plugins (downstream) | https://github.com/opendatahub-io/ai-gateway-payload-processing |
| MaaS | https://github.com/opendatahub-io/models-as-a-service |
| Praxis | https://github.com/praxis-proxy/praxis |
| vLLM Agentic API | https://github.com/vllm-project/agentic-api |
| OGX (formerly LlamaStack) | https://github.com/ogx-ai/ogx |
| Open Responses | https://www.openresponses.org/ |

### Design Documents

| Document | URL |
|----------|-----|
| RFC: AI Plugin Concept | https://github.com/danielezonca/ai-gateway-docs/blob/responses-api-wip/responses-api/rfc-ai-plugin-concept.md |
| Agentic Loop Phases | https://github.com/danielezonca/ai-gateway-docs/blob/responses-api-wip/responses-api/responses-api-agentic-loop.md |
| Unified Plugin Catalog | https://github.com/danielezonca/ai-gateway-docs/blob/responses-api-wip/responses-api/agentic-loop-plugins.md |
| Responses API Flow Visualizer | https://noyitz.github.io/ai-gateway-docs/responses-api/ |
| AI Gateway Flow Visualizer | https://noyitz.github.io/ai-gateway-docs/ai-gateway-flow.html |

### Meeting References

| Meeting | Date |
|---------|------|
| Responses API Sync | May 15, 2026 |
| AI Gateway F2F (Boston) | ~May 1, 2026 |

### Key API References

| API | Documentation |
|-----|--------------|
| OpenAI Responses API | https://developers.openai.com/api/reference/responses/overview |
| Open Responses Spec | https://www.openresponses.org/specification |
| OpenAI Responses vs Chat Completions | https://platform.openai.com/docs/guides/responses-vs-chat-completions |
| vLLM OpenAI-Compatible Server | https://docs.vllm.ai/en/stable/serving/openai_compatible_server/ |

---

*This document was generated on May 15, 2026 based on research across 8 repositories, 2 meeting transcripts, 6 design documents, and the OpenAI/Open Responses specifications.*
