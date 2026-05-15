# Responses API — Implementation Plan

**Date:** May 15, 2026

---

## Short-Term Plan (0-4 months)

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
| **IPP: api-translation** | Bidirectional Responses API <-> Chat Completions for all 5 providers | 🆕 Extend existing plugin |
| **IPP: guardrails** | Parse Responses API input format for NeMo guardrails | 🆕 Extend existing plugin |
| **IPP: model-provider-resolver** | Route to internal (pass-through) vs external (translate) | Existing, unchanged |
| **IPP: apikey-injection** | Inject provider credentials | Existing, unchanged |

| Task | Where |
|------|-------|
| Extend api-translation: Responses API -> Chat Completions for external providers | `ai-gateway-payload-processing` |
| Response translation: Chat Completions response -> Responses API Items format | `ai-gateway-payload-processing` |
| Decide: support Responses API -> OpenAI Responses API (direct, no translation)? | Design decision |
| Guardrails: extend NeMo guards to parse Responses API input format | `ai-gateway-payload-processing` |
| E2E: Responses API tests on all 5 providers | E2E tests |

**Deliverable:** External model users can send Responses API format and get correct responses from all providers.

---

### Phase 3: Agentic Loop Integration (Weeks 8-16)

**Goal:** Integrate OGX-backed agentic loop for internal models with MCP tool support. Most agentic plugins already exist in OGX -- this phase is integration, not greenfield.

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
| **Agentic Loop** | Orchestrate multi-turn tool-calling loops | 🆕 New component (Praxis-based) |
| **conversation-manager** | Hydrate context, persist after completion | ♻️ Reuse OGX Conversations API |
| **tool-registry** | Discover MCP tools via `tools/list` | ♻️ Reuse OGX ToolRuntime |
| **inference-caller** | Call vLLM's stateless `/v1/responses` | ♻️ Reuse OGX Orchestrator |
| **loop-controller** | Detect tool calls, decide: loop or complete | ♻️ Reuse OGX Orchestrator loop |
| **mcp-executor** | Execute MCP tool calls | ♻️ Reuse OGX MCP actor |
| **response-store** | Persist responses for `previous_response_id` | ♻️ Reuse OGX Store / Agentic API |
| **OGX** | Backend for conversations, files, vector stores | ♻️ Deploy existing (production-ready) |

| Task | Where |
|------|-------|
| Deploy OGX as state service backend | OGX deployment |
| Wire agentic loop to call OGX APIs for hydration/persistence | `vllm-project/agentic-api` |
| Wire agentic loop to call OGX ToolRuntime + MCP actor | `vllm-project/agentic-api` |
| Integrate OGX Orchestrator loop logic (or thin version in Praxis) | `vllm-project/agentic-api` |
| Contribute to vLLM Agentic API project (Praxis-based architecture) | `vllm-project/agentic-api` |
| Demo: Responses API request with MCP tools, server executes tool loop | Demo |

**Deliverable:** Working POC of agentic loop with MCP tools on internal model, backed by OGX state services.

---

## Long-Term Plan (6-18 months)

### Phase 4: Praxis Migration (Months 6-12)

**Goal:** Replace Envoy + ext_proc with Praxis for AI traffic.

| Task | Where |
|------|-------|
| Rewrite IPP plugins as Praxis Rust filters | `praxis-proxy/praxis` or downstream |
| StreamBuffer body inspection replaces ext_proc gRPC roundtrips | `praxis-proxy/praxis` |
| Re-entrant filter chains for agentic loop orchestration | `praxis-proxy/praxis` |
| Praxis Kubernetes operator integration | `praxis-proxy/operator` |
| Benchmark: Praxis vs Envoy+ext_proc latency comparison | Performance testing |
| Migration path: Praxis as Envoy ext_proc server (intermediate step) | `praxis-proxy/extproc` |

### Phase 5: Full Agentic Platform (Months 9-15)

**Goal:** Production-ready Responses API with full tool support.

| Task | Where |
|------|-------|
| OGX integration for Files/Vector Stores/Conversations | OGX + gateway |
| Built-in tools: file_search, web_search, code_interpreter | Agentic loop |
| Background mode (`background: true`) | Agentic loop |
| Function tool round-trip (client-side tools) | Agentic loop |
| Multi-tenancy for state services | MaaS + OGX |
| Guardrails: native Responses API format (no translation) | Guardrails service |
| Compaction API (`POST /v1/responses/compact`) | Agentic loop + OGX |

### Phase 6: Unified Gateway (Months 12-18)

**Goal:** Simplified architecture with Praxis as the single proxy + orchestrator.

| Component | Current | Target |
|-----------|---------|--------|
| Proxy | Istio/Envoy | Praxis |
| Body inspection | ext_proc gRPC (Go) | Inline Praxis filters (Rust) |
| Agentic loop | External service | Praxis re-entrant filter chains |
| Plugin system | Go CycleState framework | Rust filter pipeline with branch chains |
| MCP gateway | Not implemented | Praxis built-in (tool catalog, session mgmt) |
| Config | Kuadrant CRDs | Direct Praxis YAML or operator CRDs |

### Target Architecture (Long-Term)

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

## Where to Write the Code

| What | Where | Why |
|------|-------|-----|
| **Agentic loop core** | `vllm-project/agentic-api` (upstream) | Community project; Praxis-based architecture. |
| **Agentic loop plugins** (Rust) | `vllm-project/agentic-api` or Praxis plugins repo | Compiled into Praxis; don't need same repo. |
| **Gateway intake plugins** | `ai-gateway-payload-processing` (Go) -> Praxis (Rust) | Existing plugins work. Rewrite when Praxis ready. |
| **OGX state integration** | `vllm-project/agentic-api` depends on OGX APIs | OGX provides Files, Vector Stores, Conversations. |
| **MaaS route support** | `opendatahub-io/models-as-a-service` | HTTPRoute for `/v1/responses`. |
| **Praxis core** | `praxis-proxy/praxis` (upstream) | Re-entrant loops, MCP gateway, sub-requests. |
| **Guardrails extensions** | `ai-gateway-payload-processing` -> Praxis filter | Extend NeMo guards for Responses API format. |
| **Documentation** | `noyitz/ai-gateway-docs` | Flow diagrams, architecture docs, plugin catalog. |
| **E2E tests** | `noyitz/api-tests` + `ai-gateway-payload-processing` | Responses API E2E across internal + external. |

---

## Open Questions

1. **Who owns the agentic loop in our product?** The vLLM Agentic API project is community-driven and pre-MVP. If it doesn't mature fast enough, do we build our own orchestration in Praxis plugins?

2. **Praxis maturity risk.** Praxis is 6 weeks old with a small contributor base. The v0.5.0 milestone (Responses API, 158 issues) is due Jul 27. Can it deliver?

3. **OGX dependency.** OGX provides state services but it's a Python server. Performance concerns for high-throughput state operations? OGX services should be replaceable over time -- design the state service interface to be pluggable.

4. **Migration from old upstream to new upstream.** The downstream `ai-gateway-payload-processing` still depends on `kubernetes-sigs/gateway-api-inference-extension`. When does it migrate to `llm-d/llm-d-inference-payload-processor`?

5. **Responses API for external models -- how lossy is translation?** "No translation" for internal models is agreed. For external models, Responses -> Chat Completions is inherently lossy. How much do we invest vs telling users to use Chat Completions for external models?

6. **Multi-tenancy for state.** MaaS quota management for Files, Vector Stores. How do entitlements work? Who pays for vector store storage?

7. **Rate limiting placement.** Pre- or post-conversation retrieval? Both have tradeoffs.

8. **ITS (Intelligent Ticket System)** -- raised during sync. What is it and how does it fit?

9. **Compaction API** -- `POST /v1/responses/compact` is a high-severity gap. Blocks lossless context management for long conversations.

10. **Customer demand.** Need to follow up on customer interest. Until we hear back, we're building speculatively.

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Praxis doesn't mature fast enough | Stuck on Envoy+ext_proc | Keep Go IPP working; Praxis ext_proc bridge as fallback |
| vLLM Agentic API stalls (Rust vs Python) | No community-backed agentic loop | Build in Praxis independently; contribute back later |
| Open Responses spec doesn't get traction | No standard to build against | Build against OpenAI's actual API; spec is a bonus |
| OGX strategic shift | State services dependency at risk | Abstract state service interface; pluggable backends |
| Guardrails can't handle Responses API natively | Output guardrails break on Items format | Invest in guardrail Responses API support early |
| External model translation too lossy | Poor UX for SaaS model users | Be transparent; recommend Chat Completions for external models |

---

## Appendix: Research Sources

### Repos

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

### API References

| API | URL |
|-----|-----|
| OpenAI Responses API | https://developers.openai.com/api/reference/responses/overview |
| Open Responses Spec | https://www.openresponses.org/specification |
| Responses vs Chat Completions | https://platform.openai.com/docs/guides/responses-vs-chat-completions |
| vLLM Server | https://docs.vllm.ai/en/stable/serving/openai_compatible_server/ |
