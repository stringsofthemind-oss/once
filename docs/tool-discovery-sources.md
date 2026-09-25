# Once Universal Tool Discovery — source catalog

Last researched: 2026-09-25

Purpose: define the current discovery surfaces Once should use to build a complete, continuously refreshed inventory of tools available to developers, AI coding agents, application agents, and model runtimes.

This is a discovery catalog, not an execution policy. Finding a tool must not automatically authorize, launch, rewrite, or protect it.

## Evidence levels

Once should preserve where each tool record came from. Sources are ordered from strongest to weakest evidence of actual availability/use.

1. **EXECUTED** — an actual tool call was observed at runtime.
2. **MODEL_VISIBLE** — the final tool set sent to the model is known.
3. **RUNTIME_REGISTERED** — the framework/agent reports the tool as registered.
4. **SERVER_AUTHORITATIVE** — an MCP server returned the tool from `tools/list`.
5. **HOST_CONFIGURED** — an IDE/agent host configuration declares the server/tool source.
6. **SOURCE_DISCOVERED** — source/package/config scanning found a likely tool definition or consequential operation.
7. **REGISTRY_CANDIDATE** — a registry/catalog says a tool/server exists, but it is not known to be installed or usable by this project.

## 1. MCP protocol — primary universal source

### Authoritative discovery

- `tools/list` — enumerate the server's actual current tool definitions.
- Follow pagination/cursors until the complete list is collected.
- Capture tool name, description, input schema, annotations, server identity, transport, and source config.
- Preserve `annotations.readOnlyHint` and `annotations.openWorldHint` as hints, not as security proofs.
- When the server advertises tool-list changes, subscribe and refresh rather than treating the first list as permanent.
- MCP 2026-07-28 delivers list-change events through `subscriptions/listen`; legacy clients may receive `notifications/tools/list_changed` directly.

Implementation priority: **P0**.

References:
- https://modelcontextprotocol.io/
- https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/client/client/client.html
- https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28

## 2. MCP host/config discovery

### VS Code

Discover:
- workspace `.vscode/mcp.json`
- Dev Container `devcontainer.json` → `customizations.vscode.mcp`
- VS Code's own automatic discovery sources

VS Code currently knows how to discover MCP config from:
- Claude Desktop
- GitHub Copilot CLI
- Cursor global
- Cursor workspace
- Windsurf

Reference:
- https://code.visualstudio.com/docs/agents/reference/mcp-configuration
- https://code.visualstudio.com/docs/agent-customization/mcp-servers

Priority: **P0**.

### Claude Desktop

Known config locations exposed by VS Code's discovery documentation:
- Windows `%APPDATA%\Claude\claude_desktop_config.json`
- macOS `~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux `$XDG_CONFIG_HOME/Claude/claude_desktop_config.json`, falling back to `~/.config/Claude/claude_desktop_config.json`

Priority: **P0**.

### Claude Code

Discover:
- project `.mcp.json`
- configured servers through `claude mcp` / `claude mcp list`
- tool permissions supplied through Claude Code configuration/CLI (`--allowedTools`, `--disallowedTools`) as visibility-policy metadata

Project-scoped MCP files require user approval before Claude Code uses them; Once should preserve that trust state if observable.

References:
- https://docs.anthropic.com/en/docs/claude-code/mcp
- https://docs.anthropic.com/en/docs/claude-code/cli-usage

Priority: **P0**.

### Cursor IDE / Cursor Agent

Discover:
- project `.cursor/mcp.json`
- global `~/.cursor/mcp.json`
- programmatic registrations through Cursor's MCP extension API where observable
- `cursor-agent mcp list`
- `cursor-agent mcp list-tools <server>` as a strong host-side enumeration source
- Cursor CLI permission files: `~/.cursor/cli-config.json` and project `.cursor/cli.json` for shell/file capability policy

References:
- https://docs.cursor.com/context/model-context-protocol
- https://docs.cursor.com/en/cli/reference/parameters
- https://docs.cursor.com/cli/reference/permissions

Priority: **P0**.

### GitHub Copilot CLI

Discover:
- user `<COPILOT_HOME>/mcp-config.json`, normally `~/.copilot/mcp-config.json`
- project `.mcp.json` from working directory up to repository root
- repository `.github/mcp.json`
- `copilot mcp list --json`
- `copilot mcp get <server> --json`
- plugin-provided MCP servers
- organization/enterprise registry URL and allowlist policy when exposed
- built-in GitHub MCP server

Copilot CLI project definitions override user definitions, and nearer project config wins when names conflict. Once should model this precedence instead of flattening duplicate names blindly.

Reference:
- https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers

Priority: **P0**.

### GitHub Copilot cloud agent / code review

Discover repository-level MCP configuration through GitHub repository settings/API when available to the connected account.

Important runtime policy:
- GitHub MCP and Playwright MCP may be enabled by default in this environment.
- Copilot code review only accepts MCP tools whose `annotations.readOnlyHint` is true.

Reference:
- https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers

Priority: **P1**.

### OpenAI Codex

Discover:
- `~/.codex/config.toml`
- `[mcp_servers.*]` definitions
- `codex mcp list`
- Codex IDE extension shares the MCP configuration with Codex CLI

Reference:
- https://developers.openai.com/learn/docs-mcp

Priority: **P0**.

### Windsurf

Discover:
- `~/.codeium/windsurf/mcp_config.json`

This path is also an official VS Code MCP automatic-discovery source.

Reference:
- https://code.visualstudio.com/docs/agents/reference/mcp-configuration

Priority: **P0**.

### Other MCP clients

Support generic parsing of standard `mcpServers` JSON so Once is not hard-coded only to named hosts. Pydantic AI, Strands, Claude, Cursor and other ecosystems reuse this shape.

Priority: **P0**.

## 3. Agent/framework runtime discovery

### OpenAI Agents SDK

Discover from the live agent object:
- `Agent.tools`
- `Agent.mcp_servers`
- `Agent.get_mcp_tools()`
- function tools
- hosted tools
- hosted MCP tools
- local/runtime shell/computer/apply-patch tools
- agents-as-tools
- deferred tools / `ToolSearchTool`
- tool namespaces

Capture both registered tools and deferred tools actually loaded by tool search.

References:
- https://openai.github.io/openai-agents-python/tools/
- https://openai.github.io/openai-agents-python/mcp/

Priority: **P0**.

### Raw OpenAI Responses / tool-calling requests

Observe the final `tools` payload presented to the model and resulting tool-call items. This is stronger than static source discovery because it shows the actual model-visible set for the request.

Include hosted tools, function tools, hosted MCP, tool search and programmatic tool calling where used.

Priority: **P0**.

### Anthropic API / Claude application tool calling

Observe model-request tool definitions and emitted tool-use blocks. Also discover remote MCP connections where the application uses Anthropic's MCP connector.

Priority: **P1**.

### Google Gemini API

Discover:
- custom function declarations in request `tools`
- built-in tools such as Search, Maps, URL Context, File Search and Code Execution where exposed
- Remote MCP server definitions in Interactions API
- emitted function-call steps and call IDs

References:
- https://ai.google.dev/gemini-api/docs/tools
- https://ai.google.dev/gemini-api/docs/function-calling

Priority: **P1**.

### Google Agent Development Kit (ADK)

Discover:
- agent `tools` lists / plain function tools
- ADK built-in tools and code executors
- `McpToolset` / remote MCP tools
- tool calls from ADK runtime/telemetry

Reference:
- https://google.github.io/adk-docs/

Priority: **P1**.

### Vercel AI SDK

Discover:
- `tools` passed to `generateText`, `streamText`, agents and tool-loop agents
- tool definitions created with `tool()` / JSON Schema / Zod
- tool calls in returned `steps`
- `onStepFinish`, stream tool-call events and UI `onToolCall` hooks
- dynamically limited tool sets prepared per step

References:
- https://ai-sdk.dev/
- https://ai-sdk.dev/docs

Priority: **P0** for TypeScript projects.

### LangChain / LangGraph

Discover:
- agent/tool collections (`BaseTool` instances)
- model-bound tools
- dynamically selected tools
- MCP adapters where present
- tool execution through `wrap_tool_call` / `awrap_tool_call` middleware

LangChain middleware is a particularly useful Once interception/observation point because it can inspect the tool call before the handler executes.

Reference:
- https://reference.langchain.com/python/langchain/agents/middleware/types/wrap_tool_call

Priority: **P0**.

### Pydantic AI

Discover:
- agent `toolsets`
- `FunctionToolset`
- `ExternalToolset`
- dynamic toolsets generated per run/step
- `AbstractToolset.get_tools()`
- `MCPToolset`
- multi-server configs through `load_mcp_toolsets`
- LangChain toolsets bridged into Pydantic AI

References:
- https://pydantic.dev/docs/ai/tools-toolsets/toolsets/
- https://pydantic.dev/docs/ai/mcp/overview/

Priority: **P1**.

### AWS Strands Agents

Discover:
- `Agent(tools=[...])`
- custom `@tool` functions
- vended tools
- tools loaded from `./tools/` when automatic tool loading is enabled
- MCP clients / `listTools()` / `list_tools_sync()`
- agents-as-tools
- MCP Router dynamic connections and its `list_tools` surface
- Strands Harness `mcp_servers` JSON configs

References:
- https://strandsagents.com/docs/user-guide/sdk/tools/
- https://strandsagents.com/docs/user-guide/sdk/tools/mcp-tools/

Priority: **P1**.

### Microsoft Semantic Kernel

Discover:
- Kernel plugins
- kernel functions (`KernelFunction`)
- OpenAPI-imported plugins
- MCP plugins (`MCPStdioPlugin`, `MCPStreamableHttpPlugin`)
- plugin/function invocations through Kernel runtime instrumentation

References:
- https://learn.microsoft.com/en-us/semantic-kernel/concepts/plugins/
- https://learn.microsoft.com/en-us/semantic-kernel/concepts/plugins/adding-mcp-plugins

Priority: **P1**.

### Microsoft AutoGen / Agent Framework compatibility

Discover tool/workbench collections and runtime tool calls where present. Prefer runtime enumeration interfaces such as workbench/list-tools over source-only detection.

Priority: **P1**; validate exact adapter APIs against the installed framework version during implementation because Microsoft's agent SDK surface is evolving.

### CrewAI

Discover:
- tools supplied to agents/tasks
- CrewAI tool packages
- MCP-backed tools
- runtime tool-call events/hooks when available

Priority: **P1**; validate exact installed-version APIs during adapter implementation.

### LlamaIndex

Discover function tools, tool specs/tool collections, MCP integrations, and agent runtime tool calls.

Priority: **P2**.

### Agno

Discover toolkits/tools registered with agents, MCP integrations and runtime tool calls.

Priority: **P2**.

## 4. Source and dependency discovery

This remains useful for things that are not visible through a live agent runtime.

### Package/dependency manifests

Scan, without exposing secrets:
- `package.json`
- npm/yarn/pnpm/bun lockfiles
- `pyproject.toml`
- `requirements*.txt`
- Poetry/PDM/uv lockfiles
- `Pipfile`
- `Gemfile`
- `go.mod`
- Maven/Gradle manifests
- .NET project files / NuGet assets

Use package identity to activate framework-specific adapters; do not treat a dependency alone as proof a tool is active.

Priority: **P0** for JS/TS/Python, **P2** for additional languages.

### Source registration patterns

Use AST-aware analysis where possible, regex only as fallback. Detect:
- `tools=[...]`, `toolsets=[...]`, `bind_tools(...)`, `Agent(... tools=...)`
- decorators such as `@tool`, `@function_tool`, `@kernel_function`
- Vercel `tool({...})`
- MCP client/server registration
- direct provider `tools` request payloads
- OpenAPI/plugin imports
- tool registries built dynamically in code

Priority: **P0**.

### Existing Once consequential-operation scanner

Keep current mutation heuristics (payments, messages, bookings, HTTP writes, database writes, queues, storage, account mutations, publish/deploy) as a fallback discovery source. These identify consequential operations even when the developer did not model them as LLM tools.

Current implementation: `sdk/typescript/src/scan.ts`.

Priority: **P0**, but classify its evidence as `SOURCE_DISCOVERED`, not authoritative runtime inventory.

## 5. API-description and generated-tool sources

Discover tool candidates from:
- OpenAPI / Swagger specs
- JSON Schema-based tool catalogs
- Postman collections
- GraphQL schemas/mutation definitions
- SDK client methods generated from API specs
- framework plugin manifests

Semantic Kernel can import OpenAPI plugins; AI tool generators can also produce model tools from OpenAPI. Therefore an OpenAPI document may represent a large latent tool surface even if only a subset is model-visible.

Priority: **P1**.

## 6. Developer execution surfaces

These are not automatically LLM tools, but they are important capabilities used by developers and coding agents.

Discover declared capabilities from:
- shell/terminal tools exposed by coding agents
- package scripts in `package.json`
- Makefile / Taskfile / Justfile
- PowerShell scripts
- shell scripts
- Docker / Docker Compose
- Terraform / Pulumi
- kubectl / Helm
- Git / GitHub CLI
- cloud CLIs (AWS, Azure, gcloud)
- database CLIs
- deployment CLIs (Vercel, Cloudflare Wrangler, Railway, Fly, etc.)

Do not system-wide keylog or silently monitor arbitrary processes. Prefer explicit agent hooks, shell wrappers, audit/telemetry integrations, or declared command capabilities.

Priority: **P1** for coding-agent observation, **P2** for human shell observation.

## 7. CI/CD and automation sources

Discover executable capabilities and consequential operations from:
- `.github/workflows/*.yml`
- GitLab CI
- CircleCI
- Jenkinsfiles
- Azure Pipelines
- Buildkite
- deployment manifests
- repository hooks

Record jobs/actions/commands as `DEVELOPER_AUTOMATION` capabilities, not as model tools unless they are actually exposed to an agent.

Priority: **P2**.

## 8. Observability/runtime evidence

### OpenTelemetry

Prefer standardized runtime observation when direct framework adapters are unavailable. Capture tool/agent spans without capturing arguments by default.

Minimum default fields:
- tool identity/name
- framework/provider
- agent identity where available
- operation/call ID
- started/finished timestamp
- success/failure
- duration
- schema fingerprint if available

Tool arguments/results must be opt-in or explicitly redacted because they may contain credentials or customer data.

Priority: **P1**.

### Framework callbacks/tracing

Consume native callbacks when they expose actual calls:
- OpenAI Agents tracing/run items
- LangChain middleware/tool events
- Vercel AI SDK step/tool-call callbacks
- ADK tool-call traces
- Pydantic AI toolset hooks
- equivalent framework event streams

Priority: **P0/P1** depending on ecosystem.

## 9. Registries/catalogs — discovery candidates only

These sources tell Once what *could* be installed, not what is actually installed.

Examples:
- official MCP Registry
- GitHub MCP Registry
- Cursor MCP directory
- provider-specific MCP catalogs
- package registries (npm, PyPI)
- tool marketplaces/catalogs such as Composio/Smithery/StackOne/Toolhouse where relevant

Never classify a registry result as active merely because it exists in a marketplace.

Priority: **P2**.

## 10. Canonical Once Tool Graph record

Every source should normalize to one identity model.

Recommended minimum:

```json
{
  "tool_id": "sha256:...",
  "canonical_name": "refund_payment",
  "display_name": "Refund Payment",
  "origin": {
    "kind": "mcp|framework|provider|shell|ci|source|registry",
    "host": "cursor",
    "server": "stripe",
    "scope": "workspace"
  },
  "framework": "mcp",
  "description": "...",
  "input_schema": {},
  "annotations": {
    "read_only_hint": false,
    "open_world_hint": true
  },
  "evidence": {
    "level": "SERVER_AUTHORITATIVE",
    "source": "tools/list",
    "observed_at": "..."
  },
  "visibility": {
    "configured": true,
    "runtime_registered": true,
    "model_visible": false,
    "executed": false
  },
  "once": {
    "effect_class": "EXTERNAL_MUTATION",
    "qualification": "REVIEW_REQUIRED",
    "protected": false
  }
}
```

Tool IDs should include stable origin/server identity plus original tool name and canonical schema fingerprint. Do not use display name alone.

## 11. Effect classification

Automatic first-pass classes:
- `READ_ONLY`
- `LOCAL_MUTATION`
- `EXTERNAL_MUTATION`
- `UNKNOWN`

Evidence inputs:
- MCP annotations
- HTTP method / endpoint semantics
- schema and description
- known provider method
- function/tool name
- framework metadata
- static code behavior
- runtime observation

`readOnlyHint` is supporting evidence, not final authority for high-consequence operations.

Only tools in `EXTERNAL_MUTATION` or unresolved `UNKNOWN` should proceed to the deeper Once four-condition qualification test.

## 12. Secret and trust rules

Mandatory:
- never persist raw tokens, passwords, API keys, auth headers or secret environment values in the Tool Graph
- replace secret values with `<redacted>` while preserving variable/key names where useful
- do not launch an untrusted stdio MCP server merely to inspect it
- distinguish `CONFIGURED_NOT_PROBED` from `SERVER_AUTHORITATIVE`
- require explicit policy/user approval before launching unknown local server commands
- preserve host trust/allowlist state when observable
- discovery must be read-only by default

## 13. Initial implementation order

### Phase 11A — local/config inventory
1. generic `mcpServers` parser
2. VS Code / Claude Desktop / Claude Code / Cursor / Copilot CLI / Codex / Windsurf paths
3. project dependency/framework detection
4. source registration detection
5. normalized Tool Graph JSON output
6. `once doctor . --tools`

### Phase 11B — authoritative MCP enumeration
1. connect only to already-running/trusted remote servers by default
2. `tools/list` + pagination
3. schemas + annotations
4. tool-list change subscriptions
5. host/server precedence and namespaces

### Phase 11C — framework runtime adapters
1. OpenAI Agents / raw Responses
2. Vercel AI SDK
3. LangChain/LangGraph
4. Pydantic AI
5. Google ADK/Gemini
6. Strands
7. Semantic Kernel / Microsoft agent runtime
8. CrewAI / LlamaIndex / Agno

### Phase 11D — execution observation
1. framework callbacks
2. OTel ingestion
3. observed call counters/status
4. distinguish registered/model-visible/executed

### Phase 11E — Once Gateway / broker
Only after discovery accuracy is proven. Mirror or route tools through Once without forcing every catalog entry into model context.

## Success criterion

For a repository and developer machine, Once should be able to answer:

- Which tool sources are configured?
- Which tools currently exist on those sources?
- Which tools are registered with each application agent?
- Which subset was actually visible to the model on a given request?
- Which tools were actually executed?
- Which tools can mutate external state?
- Which consequential tools satisfy the Once four-condition test?
- Which qualifying tools are protected, unprotected, or unresolved?

without exposing secrets and without automatically launching or mutating untrusted integrations.