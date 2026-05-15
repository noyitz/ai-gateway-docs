# Responses API — Request Flow Strategy

**Date:** May 15, 2026

---

## Two Worlds: Internal vs External Models

Responses API support requires **two completely different architectures** depending on whether the model is internal (self-hosted) or external (SaaS).

- **Internal models:** Zero API translation. Full fidelity pass-through to vLLM/llm-d.
- **External models:** API translation required. Responses -> Chat Completions -> provider-native format.

---

## Flow 1: Stateless Responses API (Internal Model, Simple Completion)

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

## Flow 2: Stateful Agentic Loop (Internal Model, MCP Tools)

```mermaid
sequenceDiagram
    actor Client
    participant GW as Gateway<br/>(Istio/Praxis)
    participant MaaS as MaaS API
    participant IPP as IPP Intake<br/>Plugins
    participant AL as Agentic Loop<br/>(vLLM Agentic API)
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

    AL->>OGX: Hydrate previous_response_id
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

## Flow 3: External Model (SaaS Provider, Chat Completions Translation)

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
    Note over IPP: Lookup ExternalModel CRD<br/>resolve provider, endpoint, credentials

    IPP->>IPP: api-translation (request)<br/>OpenAI -> provider-native format
    IPP->>IPP: apikey-injection<br/>Inject provider credentials from K8s Secret

    IPP->>Provider: Translated request<br/>(provider-native format + auth headers)
    Provider-->>IPP: Provider-native response

    IPP->>IPP: api-translation (response)<br/>Provider-native -> OpenAI format

    IPP-->>Client: OpenAI-format response
```

## Flow 4: Stateful Agentic Loop (External Model, MCP Tools)

Each loop iteration requires API translation — adds latency and is inherently lossy.

```mermaid
sequenceDiagram
    actor Client
    participant GW as Gateway<br/>(Istio/Praxis)
    participant MaaS as MaaS API
    participant IPP as IPP Plugins
    participant AL as Agentic Loop<br/>(vLLM Agentic API)
    participant OGX as OGX<br/>(State Services)
    participant MCP as MCP Server
    participant Guards as Guardrails<br/>Service
    participant Provider as External Provider<br/>(OpenAI / Anthropic / etc.)

    Client->>GW: POST /v1/responses<br/>{model:"gpt-4", input:"Search for...",<br/>tools:[{type:"mcp"}],<br/>previous_response_id:"resp_abc123"}

    GW->>MaaS: Validate API key
    MaaS-->>GW: OK

    GW->>IPP: request-validator, rate-limit, model-provider-resolver
    Note over IPP: ExternalModel CRD lookup

    IPP->>AL: Forward to Agentic Loop<br/>(with provider info in CycleState)

    AL->>OGX: Hydrate previous_response_id
    OGX-->>AL: Conversation context

    AL->>MCP: tools/list (discover tools)
    MCP-->>AL: Tool catalog

    AL->>Guards: Input guardrails check
    Guards-->>AL: OK

    rect rgb(50, 30, 30)
        Note over AL,Provider: LOOP ITERATION 1 (with API translation)
        AL->>IPP: api-translation (Responses -> Chat Completions)
        IPP->>IPP: apikey-injection
        IPP->>Provider: Translated request + provider auth
        Provider-->>IPP: Provider-native response
        IPP->>AL: api-translation (response -> OpenAI format)
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

## Flow 5: Multi-Turn Continuation (previous_response_id, no tools)

```mermaid
sequenceDiagram
    actor Client
    participant GW as Gateway
    participant MaaS as MaaS API
    participant IPP as IPP Plugins
    participant AL as Agentic Loop
    participant OGX as OGX
    participant vLLM as vLLM / llm-d

    Client->>GW: POST /v1/responses<br/>{model:"llama-4", input:"Follow up",<br/>previous_response_id:"resp_abc123"}
    GW->>MaaS: Validate API key
    MaaS-->>GW: OK
    GW->>IPP: request-validator, rate-limit
    IPP-->>GW: OK

    GW->>AL: Forward (has previous_response_id)
    AL->>OGX: Hydrate resp_abc123 -> full chain
    OGX-->>AL: Previous messages + items
    AL->>vLLM: POST /v1/responses (hydrated context)
    vLLM-->>AL: Final text response

    AL->>OGX: Persist new response
    AL-->>Client: SSE: response events
```

## Flow 6: Function Tool Round-Trip (Client-Side Tools)

Two legs: first request yields control to client, second resumes after client executes the tool.

```mermaid
sequenceDiagram
    actor Client
    participant AL as Agentic Loop
    participant OGX as OGX
    participant vLLM as vLLM / llm-d

    Note over Client,vLLM: LEG 1: Model requests function call
    Client->>AL: POST /v1/responses {tools:[{type:"function",...}]}
    AL->>vLLM: Inference
    vLLM-->>AL: function_call item (name, arguments, call_id)
    AL->>OGX: Persist response (store: true)
    AL-->>Client: Response with function_call output item (status: incomplete)

    Note over Client,vLLM: Client executes tool externally

    Note over Client,vLLM: LEG 2: Client provides tool result
    Client->>AL: POST /v1/responses {previous_response_id, input:[{type:"function_call_output", call_id, output}]}
    AL->>OGX: Hydrate previous response
    OGX-->>AL: Full context
    AL->>vLLM: Inference (with tool result)
    vLLM-->>AL: Final text response
    AL->>OGX: Persist
    AL-->>Client: Response (status: completed)
```

## Flow 7: Background Processing

```mermaid
sequenceDiagram
    actor Client
    participant AL as Agentic Loop
    participant OGX as OGX
    participant vLLM as vLLM / llm-d
    participant MCP as MCP Server

    Client->>AL: POST /v1/responses {background: true, tools:[...]}
    AL->>OGX: Store queued response
    AL-->>Client: Response (status: queued, id: resp_xyz)

    Note over AL,MCP: Async worker picks up job
    AL->>vLLM: Inference
    vLLM-->>AL: tool_call
    AL->>MCP: Execute tool
    MCP-->>AL: Result
    AL->>vLLM: Inference (with result)
    vLLM-->>AL: Final response
    AL->>OGX: Persist (status: completed)

    Client->>AL: GET /v1/responses/resp_xyz
    AL->>OGX: Fetch
    OGX-->>AL: Completed response
    AL-->>Client: Full response
```
