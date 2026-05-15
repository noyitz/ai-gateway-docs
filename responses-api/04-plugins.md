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
                    ┌─── INFERENCE LOOP ───────────────────────────┐
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
                    │                                              │
                    ├─── TOOL DETECTION ───────────────────────────┤
                    │                                              │
                    │ 17. tool-call-handler        [NEW]           │
                    │ 18. loop-controller          [NEW]           │
                    │                                              │
                    ├─── TOOL EXECUTION (fan-out by type) ────────┤
                    │                                              │
                    │ 19. server-tool-executor     [NEW]           │
                    │ 20. host-tool-executor       [NEW/Sandboxed] │
                    │ 21. mcp-executor             [NEW]           │
                    │                                              │
                    │         ──── LOOP BACK to #9 ────           │
                    └──────────────────────────────────────────────┘
                                         │
                                         ▼
                    ┌─── COMPLETION (Responses only) ──────────────┐
                    │                                              │
                    │ 22. response-assembler       [NEW]           │
                    │ 23. response-store           [NEW]           │
                    │ 24. conversation-manager     [NEW] (save)    │
                    │                                              │
                    └──────────────────────────────────────────────┘
```

---

## Plugin Details

### 1. auth

| Field | Value |
|-------|-------|
| Phase | Intake |
| Boundary | External |
| Hook | on_request |
| IPP Status | Exists |
| OGX | Auth middleware |
| Reuse | Keep IPP |
| Description | Validates API key via MaaS API, injects identity headers |

### 2. rate-limit

| Field | Value |
|-------|-------|
| Phase | Intake + Loop |
| Boundary | External |
| Hook | **Dual**: on_request (quota check) + on_response (usage reporting) |
| IPP Status | Exists |
| Reuse | Keep IPP |
| CycleState writes | `total_input_tokens`, `total_output_tokens`, `total_cached_tokens` |
| Description | Token-based quota check at intake, per-iteration token accounting on response |

### 3. request-validator

| Field | Value |
|-------|-------|
| Phase | Intake |
| Boundary | Local |
| Hook | on_request |
| IPP Status | Extends |
| Reuse | Extend IPP |
| CycleState writes | `request_format` (chat_completions / responses_api), `validated_params`, `has_previous_response_id`, `has_conversation`, `has_tools`, `is_background`, `is_streaming` |
| Validation | Rejects 400 if both `previous_response_id` AND `conversation` set (mutual exclusion). Rejects 400 if `stream` AND `background` combined. |
| Description | Format-aware validation for Chat Completions messages/params OR Responses API input/tools/conversation |

### 4. hydrate-prompt

| Field | Value |
|-------|-------|
| Phase | Intake |
| Boundary | External |
| Hook | on_request only |
| IPP Status | -- |
| OGX | **Exists** (prompt hydration + templates) |
| Reuse | Reuse OGX |
| Conditional | Only when `has_previous_response_id = true` |
| CycleState reads | `previous_response_id`, `input` |
| CycleState writes | Fully hydrated prompt, `ContextEdit` records (when truncation applied) |
| Description | Loads `previous_response_id` chain (recursive: resp_3 -> resp_2 -> resp_1), resolves `item_reference`, handles `compaction_summary`, inline truncation |

**Mutual exclusion with conversation-manager:** These two plugins are mutually exclusive, enforced by `request-validator`. They differ on every axis:

| Axis | hydrate-prompt | conversation-manager |
|------|---------------|---------------------|
| Data model | Immutable response chain (frozen snapshots) | Mutable conversation (living thread) |
| Store | Response store (read-only) | Dual store: conversation items (UI) + messages (inference) |
| Hooks | on_request only | on_request + on_response |
| History owner | Client (chooses which response to chain from) | Server (maintains canonical state) |

### 5. conversation-manager

| Field | Value |
|-------|-------|
| Phase | Intake + Completion |
| Boundary | External |
| Hook | **Dual**: on_request (load) + on_response (save) |
| IPP Status | -- |
| OGX | **Exists** (Conversations API, dual storage) |
| Reuse | Reuse OGX |
| Conditional | Only when `has_conversation = true` |
| on_request | Loads conversation items + raw messages, merges with new input |
| on_response | Writes input+output items to conversation store, persists message array |
| Description | Dual-storage: conversation items for UI, raw chat messages for inference |

### 6. tool-registry

| Field | Value |
|-------|-------|
| Phase | Intake |
| Boundary | External |
| Hook | on_request |
| IPP Status | -- |
| OGX | **Exists** (ToolRuntime + MCP discovery) |
| Reuse | Reuse OGX |
| Conditional | Only when `has_tools = true` |
| CycleState writes | Resolved tool map, tool classifications |
| Tool types | Externally-hosted: `function`, `mcp`. Internally-hosted: `web_search`, `file_search`, `code_interpreter`, `image_gen`, `computer`, `local_shell`, `function_shell`, `apply_patch`, `custom` |
| Description | Resolves tools, discovers MCP servers (lazy, cached via MCPSessionManager), applies `allowed_tools` filtering, enforces `max_tools_per_request` |

### 7. guardrails

| Field | Value |
|-------|-------|
| Phase | Intake + Loop |
| Boundary | External |
| Hook | **Dual**: on_request (input safety) + on_response (output safety per iteration) |
| IPP Status | Extends (merges existing request-guard + response-guard into single dual-hook) |
| OGX | **Exists** (Shield-based safety, Moderation actor) |
| Reuse | Extend IPP + call OGX/NeMo |
| on_request | Reads hydrated prompt from CycleState, sends to moderation endpoint |
| on_response | Mid-loop rejection: violating output discarded, synthetic tool result written, loop continues. After `max_guardrail_retries` (default: 2), terminates with `stop_failed` + `guardrail_violation` |
| Description | Unified guardrails for both Chat Completions and Responses API formats |

### 8. model-provider-resolver

| Field | Value |
|-------|-------|
| Phase | Intake |
| Boundary | External |
| Hook | on_request |
| IPP Status | Exists |
| Reuse | Keep IPP (K8s-native CRDs) |
| CycleState writes | Provider type, endpoint, target model ID, credential secret reference |
| Description | Watches `ExternalModel` CRDs, resolves model -> provider + endpoint. For internal models, writes pass-through marker. |

### 9. api-translation

| Field | Value |
|-------|-------|
| Phase | Loop |
| Boundary | Local |
| Hook | **Dual**: on_request (format conversion before inference) + on_response (format conversion after inference) |
| IPP Status | Extends |
| OGX | **Exists** (multi-SDK: OpenAI, Anthropic, Google) |
| Reuse | Extend IPP (external models only) |
| CycleState reads | `request_format` |
| on_request | Converts Responses API items or Chat Completions messages to provider-native format. Handles `instructions` as system message, sampling parameters, path/header rewriting. |
| on_response | Converts provider response back. Refusal detection, annotation creation, reasoning summaries, `include` filtering, per-iteration usage to CycleState, streaming events to `CycleState.event_queue`. |
| Providers | OpenAI (passthrough), Anthropic, Azure OpenAI, AWS Bedrock, Google Vertex AI |
| **Internal models** | Skipped (no-op). No translation for native vLLM/llm-d Responses API. |

### 10. body-field-to-header

| Field | Value |
|-------|-------|
| Phase | Loop |
| Boundary | Local |
| Hook | on_request |
| IPP Status | Exists |
| Reuse | Keep IPP |
| Description | Extracts `model` field from body -> `X-Gateway-Model-Name` header for routing |

### 11. base-model-to-header

| Field | Value |
|-------|-------|
| Phase | Loop |
| Boundary | External |
| Hook | on_request |
| IPP Status | Exists |
| Reuse | Keep IPP |
| Description | Resolves LoRA adapter -> base model via K8s ConfigMaps -> `X-Gateway-Base-Model-Name` header |

### 12. apikey-injection

| Field | Value |
|-------|-------|
| Phase | Loop |
| Boundary | External |
| Hook | on_request |
| IPP Status | Exists |
| Reuse | Keep IPP |
| Description | Reads provider API key from K8s Secret, injects auth header (`Authorization: Bearer` for OpenAI, `x-api-key` for Anthropic, `api-key` for Azure) |
| **Internal models** | Skipped. No credential injection needed. |

### 13. inference-caller

| Field | Value |
|-------|-------|
| Phase | Loop |
| Boundary | External |
| Hook | on_request |
| IPP Status | -- |
| OGX | **Exists** (Orchestrator -> Inference actor) |
| Reuse | Reuse OGX / Agentic API |
| CycleState writes | Provider-native model response, `ContextEdit` if truncation applied, `inference_error` on failure |
| Truncation | Checks context size, trims if `auto`, Rejects if `disabled` and overflow |
| Retry | `max_inference_retries` (default: 0). Retries 429, 503 with backoff. Never retries 400, 401, 403. |
| Description | Direct model call with inline truncation, context window check |

### 14. api-translation (response)

Same plugin as #9, response hook. See #9 for details.

### 15. guardrails (output)

Same plugin as #7, response hook. See #7 for mid-loop rejection semantics.

### 16. rate-limit (usage)

Same plugin as #2, response hook. Per-iteration token accounting.

### 17. tool-call-handler

| Field | Value |
|-------|-------|
| Phase | Tool Detection |
| Boundary | Local |
| Hook | on_response |
| IPP Status | -- |
| OGX | **Exists** (Executor actor, tool dispatch) |
| Reuse | Reuse OGX |
| CycleState reads | Model output (from api-translation), registered tool set (from tool-registry) |
| CycleState writes | `tool_routing[]` (list of `{tool_call_id, executor_type, arguments}`), `has_server_side_tools`, `has_function_tools`, `parallel_dispatch` |
| Routing outcomes | No tools -> stop_completed; only server tools -> fan-out + continue; only function tools -> stop_yield; **mixed** -> execute server-side first, then stop_yield |
| Description | Detects, classifies, and routes tool calls from model output |

### 18. loop-controller

| Field | Value |
|-------|-------|
| Phase | Tool Detection |
| Boundary | Local |
| Hook | on_response |
| IPP Status | -- |
| OGX | **Exists** (Orchestrator streaming loop) |
| Reuse | Reuse OGX |
| CycleState reads | `current_tool_call_count`, `current_iteration`, `total_output_tokens`, `tool_routing`, `tool_choice`, `inference_error` |
| CycleState writes | `loop_action` (continue / stop_completed / stop_incomplete / stop_yield / stop_failed), accumulated totals |
| Termination | Stops on: no tool calls, `max_tool_calls` reached, `max_output_tokens` exhausted, `max_infer_iters` reached |
| `tool_choice: required` | If no tool calls with required, retries up to `max_tool_choice_retries` (default: 1), then `stop_failed` with `tool_choice_violation` |
| Chat Completions | Always signals `stop_completed` (trivial, no loop) |

### 19. server-tool-executor

| Field | Value |
|-------|-------|
| Phase | Tool Execution |
| Boundary | External |
| Hook | on_response |
| IPP Status | -- |
| OGX | **Exists** (ToolRuntime: web_search, code_interpreter, file_search, image_gen, computer, custom) |
| Reuse | Reuse OGX |
| Dispatch | file_search -> vector store, web_search -> web search API, code_interpreter -> sandbox, image_gen -> image gen service, computer -> remote desktop, custom -> pluggable backend registry |
| Error handling | Returns structured "unsupported tool" error as tool result when backend not deployed (does NOT reject) |
| Description | Configuration-driven dispatch table — adding a new tool type is a config change, not a new plugin |

### 20. host-tool-executor

| Field | Value |
|-------|-------|
| Phase | Tool Execution |
| Boundary | **Sandboxed** |
| Hook | on_response |
| IPP Status | -- |
| OGX | **Exists** (code_interpreter sandbox) |
| Reuse | Reuse OGX |
| **Default: DISABLED** | Requires explicit admin opt-in |
| Tool types | `local_shell` (shell command execution), `function_shell` (function-style shell), `apply_patch` (file patch application) |
| Security | Checks per-tool-type enable flag before execution (shared security gate) |
| Description | Executes host-level operations in sandbox. Routes to sandboxed execution environment. |

### 21. mcp-executor

| Field | Value |
|-------|-------|
| Phase | Tool Execution |
| Boundary | External |
| Hook | on_response |
| IPP Status | -- |
| OGX | **Exists** (MCP actor) |
| Reuse | Reuse OGX |
| Session | Reuses MCP session from tool-registry discovery |
| Approval flow | 5-step round-trip: (1) Server returns `mcp_approval_request` output item, (2) executor treats as yield (like function tool handoff), (3) client reviews, resumes with `mcp_approval_response`, (4) `hydrate-prompt` loads previous response, (5) `mcp-executor` checks approval and executes |
| Events | `response.mcp_call.in_progress`, `.completed`, `.failed`, `.arguments.delta`, `.arguments.done` |
| Description | MCP protocol: session management, tool invocation, approval flow |

### 22. response-assembler

| Field | Value |
|-------|-------|
| Phase | Completion |
| Boundary | Local |
| Hook | on_response |
| IPP Status | -- |
| OGX | **Exists** (response construction) |
| Reuse | Reuse OGX |
| Builds | Complete `ResponseResource`: id, object, created_at, completed_at, status (from loop_action), incomplete_details, error, output items, usage (accumulated totals), context_edits, echo-back fields (model, instructions, metadata, tools, etc.), previous_response_id |
| Description | Builds final ResponseResource from accumulated CycleState |

### 23. response-store

| Field | Value |
|-------|-------|
| Phase | Completion |
| Boundary | External |
| Hook | on_response |
| IPP Status | -- |
| OGX | **Exists** (Store + Conversations dual persistence) |
| Reuse | Reuse OGX / Agentic API |
| Conditional | Only when `store: true` |
| Description | Persists response. Retrievable via `GET /v1/responses/{id}` and referenceable by `previous_response_id`. |

### 24. conversation-manager (save)

Same plugin as #5, on_response hook. Writes input+output items to conversation store, persists message array.

---

## Plugin Classification Summary

| # | Plugin | Boundary | IPP | OGX | Reuse Strategy |
|---|--------|----------|-----|-----|----------------|
| 1 | auth | External | Exists | Auth middleware | Keep IPP |
| 2 | rate-limit | External | Exists | -- | Keep IPP |
| 3 | request-validator | Local | Extends | Validation | Extend IPP |
| 4 | hydrate-prompt | External | -- | **Exists** | Reuse OGX |
| 5 | conversation-manager | External | -- | **Exists** | Reuse OGX |
| 6 | tool-registry | External | -- | **Exists** | Reuse OGX |
| 7 | guardrails | External | Extends | **Exists** | Extend IPP + OGX/NeMo |
| 8 | model-provider-resolver | External | Exists | **Exists** | Keep IPP |
| 9 | api-translation | Local | Extends | **Exists** | Extend IPP (ext only) |
| 10 | body-field-to-header | Local | Exists | -- | Keep IPP |
| 11 | base-model-to-header | External | Exists | -- | Keep IPP |
| 12 | apikey-injection | External | Exists | -- | Keep IPP |
| 13 | inference-caller | External | -- | **Exists** | Reuse OGX/Agentic API |
| 14 | tool-call-handler | Local | -- | **Exists** | Reuse OGX |
| 15 | loop-controller | Local | -- | **Exists** | Reuse OGX |
| 16 | server-tool-executor | External | -- | **Exists** | Reuse OGX |
| 17 | host-tool-executor | Sandboxed | -- | **Exists** | Reuse OGX |
| 18 | mcp-executor | External | -- | **Exists** | Reuse OGX |
| 19 | response-assembler | Local | -- | **Exists** | Reuse OGX |
| 20 | response-store | External | -- | **Exists** | Reuse OGX/Agentic API |

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
