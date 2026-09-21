# Once + Claude Code

Add Once execution-safety tools to Claude Code through MCP.

Once helps coding agents identify and protect consequential writes that may be retried after an ambiguous timeout, crash, lost response, or other uncertain outcome.

## Fastest setup

### Windows

Native Windows requires `cmd /c` when Claude Code launches an npm-based MCP server:

```powershell
claude mcp add once --scope project -- cmd /c npx -y @once-agent/mcp
```

### macOS / Linux

```bash
claude mcp add once --scope project -- npx -y @once-agent/mcp
```

Project scope creates or updates `.mcp.json` in the project so the configuration can be shared with the repository.

Claude Code asks for approval before using a project-scoped MCP server.

## Manual configuration

This directory contains:

- `mcp.windows.json` for native Windows
- `mcp.unix.json` for macOS and Linux

Copy the appropriate `mcpServers` configuration into the project root `.mcp.json`.

## Verify

After configuring Once:

```text
claude mcp list
```

Inside Claude Code you can also use:

```text
/mcp
```

## Once tools

The Once MCP server includes tools for:

- assessing a project for consequential writes
- explaining retry risk
- planning Once setup
- applying approved protection
- verifying the Once Cloud connection
- viewing Once live proof and claim boundaries

## API key

An `ONCE_API_KEY` is only required for Once operations that need the Cloud connection, such as connection verification or configured integrations.

Keep API keys in your local environment. Do not commit them into `.mcp.json`.

## Install command

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
