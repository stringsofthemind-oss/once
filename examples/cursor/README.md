# Once + Cursor

Add Once execution-safety tools to Cursor through Model Context Protocol.

Once helps coding agents identify and protect consequential writes that may otherwise be repeated after an ambiguous timeout, crash, lost response or other uncertain outcome.

## Project setup

Copy the included `.cursor/mcp.json` into the root of your Cursor project.

The configuration launches:

```text
npx -y @once-agent/mcp
```

Project-level Cursor MCP configuration lives at:

```text
.cursor/mcp.json
```

This means the configuration can be committed with the repository and shared with the project.

## Configuration

```json
{
  "mcpServers": {
    "once": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@once-agent/mcp"]
    }
  }
}
```

## Verify with Cursor CLI

If the Cursor CLI is installed:

```text
agent mcp list
agent mcp list-tools once
```

Cursor may require approval before a project MCP server is enabled.

## Once tools

The Once MCP server includes tools for:

- assessing a project for consequential writes
- explaining retry risk
- planning Once setup
- applying approved protection
- verifying the Once Cloud connection
- viewing Once live proof and claim boundaries

## API key

An `ONCE_API_KEY` is only required for Once operations that need a configured Cloud connection.

Keep credentials in your environment rather than committing secrets to `.cursor/mcp.json`.

## Package

```text
npx -y @once-agent/mcp
```

Official MCP Registry identity:

```text
io.github.stringsofthemind-oss/once
```

## Links

- Once: https://onceexec.com/
- MCP package: https://www.npmjs.com/package/@once-agent/mcp
- Agent guide: https://onceexec.com/agent.md
- Repository: https://github.com/stringsofthemind-oss/once
