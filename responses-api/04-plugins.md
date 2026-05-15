# Responses API — Plugin Pipeline Design

**Date:** May 15, 2026

---

## Plugin Contract

Every plugin follows a strict contract:

### Plugin Actions

| Action | Meaning |
|--------|---------|
| `Continue` | Pass to next plugin in pipeline |
| `Reject(status, headers?, body?)` | Short-circuit pipeline, return error to client immediately |

All other control-flow (loop termination, function tool yield, background queueing) is expressed through CycleState values that the **executor** reads. Plugins signal intent; the executor acts.

### Plugin Hooks

Each plugin implements up to two hooks:
- **`on_request`** -- forward pipeline order, before upstream/loop
- **`on_response`** -- forward pipeline order, after upstream response

### Dual-Hook Plugins

Four plugins explicitly span both request and response:

| Plugin | on_request | on_response |
|--------|-----------|-------------|
| **api-translation** | Convert input to provider-native format | Convert provider response back to OpenAI format |
| **guardrails** | Input safety check at intake | Output safety check per loop iteration |
| **conversation-manager** | Load conversation items + messages | Save state after completion |
| **rate-limit** | Quota check (reject if exceeded) | Usage reporting (token accounting) |

### Plugin Boundaries

| Boundary | Meaning | Example |
|----------|---------|---------|
| **Local** | Pure in-process, no network I/O | request-validator, tool-call-handler |
| **External** | Requires calls to external services | guardrails (NeMo), mcp-executor (MCP servers) |
| **Sandboxed** | Host-level operations, disabled by default, admin opt-in | host-tool-executor (local_shell, apply_patch) |

### 9 Rules: What Plugins CANNOT Do

1. **Cannot control pipeline ordering** -- ordering is declared in configuration, not by plugins
2. **Cannot access other plugins directly** -- no plugin-to-plugin RPC; use CycleState only
3. **Cannot modify CycleState keys owned by other plugins** -- the plugin that creates a key owns it
4. **Cannot maintain state beyond request lifecycle** -- CycleState destroyed at end of request
5. **Cannot fork or modify the pipeline at runtime** -- pipeline is immutable during request processing
6. **Cannot block the pipeline indefinitely** -- runtime enforces per-plugin timeouts
7. **Cannot execute arbitrary code on the host** -- except sandboxed-boundary plugins (disabled by default)
8. **Cannot bypass the Plugin Action contract** -- must return Continue or Reject from every hook
9. **Cannot hold mutable singleton state across requests** -- concurrent invocation, shared-nothing

### Executor Responsibilities (NOT plugins)

| Concern | Why not a plugin | Owner |
|---------|-----------------|-------|
| Background queueing | Returns to client AND continues processing (pipeline fork) | Executor / API routing layer |
| SSE/WebSocket streaming | Writes directly to client connection | Executor / transport layer |
| Context truncation | Inline within `hydrate-prompt` and `inference-caller` | Inline within specific plugins |
| Loop iteration | Re-enters pipeline after tool execution | Executor reads `loop_action` from CycleState |
| Function tool yield | Reads `stop_yield`, exits loop | Executor coordinates loop exit and response assembly |

---

## Unified Pipeline (Target State)

```
                    ┌─── INTAKE (runs once) ──────────────────────────────────┐
                    │                                                        │
                    │  1. auth                    [IPP]                      │
                    │  2. rate-limit (check)      [IPP]                      │
                    │  3. request-validator        [Extend IPP]              │
                    │  4. hydrate-prompt           [OGX]                     │
                    │  5. conversation-manager     [OGX]                     │
                    │  6. tool-registry            [OGX]                     │
                    │  7. guardrails (input)       [IPP + OGX/NeMo]         │
                    │  8. model-provider-resolver  [IPP]                     │
                    │                                                        │
                    └────────────────────────────────────────────────────────┘
                                         │
                                         ▼
                    ┌─── INFERENCE LOOP ──────────────────────────────────────┐
                    │                                                        │
                    │  9. api-translation (req)   [Extend IPP, ext only]    │
                    │ 10. body-field-to-header    [IPP]                      │
                    │ 11. base-model-to-header    [IPP]                      │
                    │ 12. apikey-injection        [IPP]                      │
                    │          ┌──── MODEL CALL ────┐                        │
                    │ 13. inference-caller         [OGX / Agentic API]      │
                    │          └────────────────────┘                        │
                    │ 14. api-translation (resp)  [Extend IPP, ext only]    │
                    │ 15. guardrails (output)     [IPP + OGX/NeMo]         │
                    │ 16. rate-limit (usage)      [IPP]                      │
                    │                                                        │
                    ├─── TOOL DETECTION ─────────────────────────────────────┤
                    │                                                        │
                    │ 17. tool-call-handler        [OGX]                     │
                    │ 18. loop-controller          [OGX]                     │
                    │                                                        │
                    ├─── TOOL EXECUTION (fan-out by type) ───────────────────┤
                    │                                                        │
                    │ 19. server-tool-executor     [OGX]                     │
                    │ 20. host-tool-executor       [OGX / Sandboxed]        │
                    │ 21. mcp-executor             [OGX]                     │
                    │                                                        │
                    │         ──── LOOP BACK to #9 ────                     │
                    └────────────────────────────────────────────────────────┘
                                         │
                                         ▼
                    ┌─── COMPLETION (Responses only) ─────────────────────────┐
                    │                                                        │
                    │ 22. response-assembler       [OGX]                     │
                    │ 23. response-store           [OGX / Agentic API]      │
                    │ 24. conversation-manager     [OGX] (save)              │
                    │                                                        │
                    └────────────────────────────────────────────────────────┘
```

---

## Plugin Classification Summary

| # | Plugin | Boundary | IPP | OGX | Reuse Strategy |
|---|--------|----------|-----|-----|----------------|
| 1 | auth | External | [Exists](https://github.com/opendatahub-io/ai-gateway-payload-processing/tree/main/pkg/plugins/nemo) | Auth middleware | Keep IPP |
| 2 | rate-limit | External | [Exists](https://github.com/opendatahub-io/ai-gateway-payload-processing) | -- | Keep IPP |
| 3 | request-validator | Local | Extends | Validation | Extend IPP |
| 4 | hydrate-prompt | External | -- | [Exists](https://github.com/ogx-ai/ogx/tree/main/src/ogx/providers/inline/responses/builtin) | Reuse OGX |
| 5 | conversation-manager | External | -- | [Exists](https://github.com/ogx-ai/ogx/tree/main/src/ogx_api/conversations) | Reuse OGX |
| 6 | tool-registry | External | -- | [Exists](https://github.com/ogx-ai/ogx/tree/main/src/ogx_api/tools) | Reuse OGX |
| 7 | guardrails | External | [Extends](https://github.com/opendatahub-io/ai-gateway-payload-processing/tree/main/pkg/plugins/nemo) | -- | Extend IPP + OGX/NeMo |
| 8 | model-provider-resolver | External | [Exists](https://github.com/opendatahub-io/ai-gateway-payload-processing/tree/main/pkg/plugins/model-provider-resolver) | [Exists](https://github.com/ogx-ai/ogx/tree/main/src/ogx/providers/remote/inference) | Keep IPP |
| 9 | api-translation | Local | [Extends](https://github.com/opendatahub-io/ai-gateway-payload-processing/tree/main/pkg/plugins/api-translation) | [Exists](https://github.com/ogx-ai/ogx/tree/main/src/ogx/providers/remote/inference) | Extend IPP (ext only) |
| 10 | body-field-to-header | Local | [Exists](https://github.com/kubernetes-sigs/gateway-api-inference-extension/tree/main/pkg/bbr/plugins/bodyfieldtoheader) | -- | Keep IPP |
| 11 | base-model-to-header | External | [Exists](https://github.com/kubernetes-sigs/gateway-api-inference-extension/tree/main/pkg/bbr/plugins/basemodelextractor) | -- | Keep IPP |
| 12 | apikey-injection | External | [Exists](https://github.com/opendatahub-io/ai-gateway-payload-processing/tree/main/pkg/plugins/apikey-injection) | -- | Keep IPP |
| 13 | inference-caller | External | -- | [Exists](https://github.com/ogx-ai/ogx/tree/main/src/ogx_api/inference) | Reuse OGX/[Agentic API](https://github.com/vllm-project/agentic-api) |
| 14 | tool-call-handler | Local | -- | [Exists](https://github.com/ogx-ai/ogx/tree/main/src/ogx/providers/inline/tool_runtime) | Reuse OGX |
| 15 | loop-controller | Local | -- | [Exists](https://github.com/ogx-ai/ogx/tree/main/src/ogx/providers/inline/responses/builtin) | Reuse OGX |
| 16 | server-tool-executor | External | -- | [Exists](https://github.com/ogx-ai/ogx/tree/main/src/ogx/providers/inline/tool_runtime) | Reuse OGX |
| 17 | host-tool-executor | Sandboxed | -- | [Exists](https://github.com/ogx-ai/ogx/tree/main/src/ogx/providers/inline/tool_runtime) | Reuse OGX |
| 18 | mcp-executor | External | -- | [Exists](https://github.com/ogx-ai/ogx/tree/main/src/ogx/providers/remote/tool_runtime/model_context_protocol) | Reuse OGX |
| 19 | response-assembler | Local | -- | [Exists](https://github.com/ogx-ai/ogx/tree/main/src/ogx/providers/inline/responses/builtin) | Reuse OGX |
| 20 | response-store | External | -- | [Exists](https://github.com/ogx-ai/ogx/tree/main/src/ogx_api/responses) | Reuse OGX/[Agentic API](https://github.com/vllm-project/agentic-api/blob/main/docs/adr/ADR-02_response_store.md) |

**Totals:** 7 exist in IPP (keep/extend), 11 have OGX implementations to reuse, 2 being built in vLLM Agentic API.

---

## Plugin Participation by Flow Scenario

| Plugin | Chat Comp | Simple | RAG+Conv | MCP Agent | Background | Full | Multi-Turn | Func Tool |
|--------|:---------:|:------:|:--------:|:---------:|:----------:|:----:|:----------:|:---------:|
| auth | x | x | x | x | x | x | x | x |
| rate-limit | x | x | x | x | x | x | x | x |
| request-validator | x | x | x | x | x | x | x | x |
| hydrate-prompt | | | | | | | x | x* |
| conversation-manager | | | x | | | x | | |
| tool-registry | | | x | x | x | x | | x |
| guardrails | x+ | | | | | x | | |
| model-provider-resolver | x | x | x | x | x | x | x | x |
| api-translation | x | x | x | x | x | x | x | x |
| body-field-to-header | x | x | x | x | x | x | x | x |
| base-model-to-header | x | x | x | x | x | x | x | x |
| apikey-injection | x | x | x | x | x | x | x | x |
| inference-caller | x | x | x | x | x | x | x | x |
| tool-call-handler | | | x | x | x | x | | x |
| loop-controller | x++ | x | x | x | x | x | x | x |
| server-tool-executor | | | x | | x | x | | |
| host-tool-executor | | | | | | | | |
| mcp-executor | | | | x | x | x | | |
| response-assembler | | x | x | x | x | x | x | x |
| response-store | | x | x | x | x | x | x | x |

\* hydrate-prompt active in resume leg of Function Tool flow
\+ guardrails for Chat Completions runs when enabled
\++ loop-controller for Chat Completions is trivial: always stop_completed

---

## Conditional Execution

For **Chat Completions** requests, plugins 4-6, 14-15, 17-21, 22-24 are **skipped**. The pipeline collapses to the existing IPP flow. `request-validator` sets `request_format = chat_completions` in CycleState.

For **internal models**, plugins 9 (api-translation req), 12 (apikey-injection), and 14 (api-translation resp) are **skipped** or become no-ops. No translation for native vLLM/llm-d Responses API.

### Single-Pass vs Multi-Pass IPP Plugin Disposition

In multi-pass Responses API flows, IPP sees only a fragment (bare `input`) without conversation history:

| Plugin | Single-Pass | Multi-Pass Intake | Per-Iteration | Rationale |
|--------|:-----------:|:-----------------:|:-------------:|-----------|
| auth | Runs | Runs | Skip | Key validated once |
| rate-limit (check) | Runs | Runs | Skip | Quota checked at intake |
| rate-limit (report) | Runs | -- | Runs | Token accounting per-iteration |
| guardrails (input) | Runs | Skip in IPP | -- | Runs post-hydration in agentic loop instead |
| guardrails (output) | Runs | -- | Skip in IPP | Agentic loop has richer context |
| model-provider-resolver | Runs | Skip | Skip | Static for request lifetime |
| api-translation (req) | Runs | -- | Runs | Different messages each iteration |
| apikey-injection | Runs | Skip | Skip | Credential doesn't change |
| api-translation (resp) | Runs | -- | Runs | Must translate each iteration's response |

---

## Open Gaps

| Gap | Severity |
|-----|----------|
| Compaction API (`POST /v1/responses/compact`) | **High** -- blocks lossless context management |
| Response retrieval API (`GET /v1/responses/{id}`) | Medium |
| Tool backend services (web_search, code_interpreter, image_gen, computer) | Medium |
| `intelligent-model-selection` plugin (scope undefined) | Medium |
| MCP approval flow -- no flow scenario demonstrates it yet | Low |
| Error/failure flow scenarios not documented | Low |
