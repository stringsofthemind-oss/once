# Once for Claude Code

Once adds execution-safety tools to Claude Code through Model Context Protocol.

It helps identify consequential external writes and reason about retry safety when a timeout, crash, lost response or other ambiguous outcome means an agent cannot safely assume an operation failed.

## What this plugin provides

The plugin automatically exposes the public `@once-agent/mcp` server to Claude Code.

Once MCP tools include:

- assessment of likely consequential writes
- retry-risk explanations
- Once setup planning
- approved protection application
- Once Cloud connection verification
- live proof and current claim boundaries

## MCP server

The plugin launches:

```text
npx -y @once-agent/mcp@0.1.2
```

A small cross-platform launcher selects `npx.cmd` on Windows and `npx` on macOS/Linux.

## Credentials

Keep `ONCE_API_KEY` in your environment.

Do not commit API keys into plugin configuration or source control.

## Claim boundary

Once does not claim universal exactly-once execution. Safety depends on stable operation identity, durable Once state, provider integration and sufficiently authoritative provider truth.

When an outcome cannot be established safely, Once can preserve uncertainty instead of blindly repeating an external action.

## Links

- Website: https://onceexec.pages.dev/
- Claude Code guide: https://onceexec.pages.dev/claude-code-mcp-safe-retries/
- MCP package: https://www.npmjs.com/package/@once-agent/mcp
- MCP Registry: io.github.stringsofthemind-oss/once
- Source: https://github.com/stringsofthemind-oss/once
