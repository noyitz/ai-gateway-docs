# Responses API — Components and Responsibilities

**Date:** May 15, 2026

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

---

## Component Responsibilities

### vLLM Core (Stateless Inference)

| Responsibility | Details |
|---------------|---------|
| Stateless Responses API | Accept `/v1/responses` requests, produce responses with Items. No state management. |
| Chat Completions | Existing `/v1/chat/completions` continues unchanged. |
| Messages API | Existing `/v1/messages` continues unchanged. |
| Token generation | Core competency: fast, efficient inference with KV-cache, speculative decoding, etc. |
| **NOT responsible for** | State storage, agentic loops, tool execution, conversation history, file/vector stores. |

### vLLM Agentic API (Stateful Orchestration) — Praxis runtime long-term

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

OGX services are **replaceable over time** -- the state service interface should be pluggable, not OGX-specific.

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
| Model routing | Resolve model name -> provider + endpoint via ExternalModel CRD. |
| API translation | Convert between OpenAI <-> provider-native formats (external models ONLY). |
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

### Design Principle: Routing Orthogonal to Persistence

The gateway's routing decisions should not depend on conversation state. Model routing is determined at intake time from the request payload. Persistence (conversations, response store) happens after inference, not before routing.

### Design Principle: Rate Limiting Placement

Open question: should rate limiting run pre- or post-conversation retrieval?
- **Pre-hydration:** Saves work on rejected requests, but can't account for actual token count including history.
- **Post-hydration:** Can rate-limit based on full context size, but rejected requests still pay hydration cost.
