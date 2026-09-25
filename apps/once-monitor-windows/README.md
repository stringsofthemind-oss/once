# Once Monitor — Windows

Once Monitor is the Windows customer-facing companion for Once.

It makes local Once status visible from the Windows system tray without moving execution safety into the desktop UI.

> **THE SAME ACTION SHOULD HAPPEN ONCE.**

## Product role

Once Monitor answers four customer questions quickly:

1. Is the local Once environment visible and healthy?
2. What tools has Once discovered?
3. Which tools have verified protection state or need attention?
4. What should I do next?

Monitor is an assistive control/status surface. It is **not** the Once execution engine.

Closing, crashing, upgrading, or exiting Monitor must never disable Once protection. Execution safety continues to live in the SDK / Connect / Gateway execution path.

## Windows experience

Once Monitor runs as a single-instance tray process.

- **Left-click** the `1x` tray mark to open or hide the compact panel.
- **Click away** to collapse the panel.
- **Right-click** for Open Once, Doctor, Settings, Copy diagnostics, and Exit Monitor.
- **Exit Monitor** exits only the UI process.
- Once Setup can register the successfully installed project and start Monitor without passing the Once API key to it.
- The packaged app uses the Windows `startupTask` integration for Start with Windows. An unpackaged developer executable uses a per-user Run-key fallback.

The packaged MSIX also declares Once Monitor as its own Windows application so the customer can reopen it after intentionally exiting the tray process.

## Visual language

Monitor reuses the existing Once Windows theme and website status semantics.

| Signal | Meaning |
| --- | --- |
| Dark surface + green `1x` mark | Once identity / normal state |
| Red heartbeat | Monitor is alive; **not** an error signal |
| Cyan heartbeat pulse / tray state | New execution evidence was actually observed |
| Green tray status | Local Monitor snapshot is ready |
| Amber tray status | Tool safety needs customer attention |
| Red tray status marker | Local Monitor status is unavailable/problematic |

`READY` means the local Monitor snapshot is healthy. It does **not** mean every discovered tool is protected.

Monitor may say a tool is protected only when the Tool Graph reports a verified protection state.

## Surfaces

### Overview

Shows a concise customer status:

- verified-protection count;
- tools needing attention;
- read-only/generation-only count;
- project name (basename only);
- discovered tool count;
- model-visible count;
- configured source count;
- observed framework names when available;
- execution-evidence count;
- unknown/review count;
- snapshot time.

### Tools

Shows safe per-tool metadata only:

- tool name;
- effect class;
- importance band;
- action priority;
- evidence level;
- protection state.

The view does not need source snippets, prompts, arguments, results, credentials, configured commands, or provider payloads.

### Activity

V1 reports the amount of current execution evidence present in Tool Graph records.

The current discovery snapshot is not a durable chronological event log, so V1 deliberately does **not** invent timestamps, duplicate-suppression events, or historical activity. The UI says this explicitly when `chronologicalActivityFeed` is false.

A future timeline must be backed by real local event evidence before it is rendered.

### Doctor

Runs the existing project-local `once doctor <project> --tools` command and displays its local output.

Copy diagnostics produces a separate sanitized summary suitable for support. The copied summary contains counts/status but not the absolute project path or customer payloads.

### Settings

Customer-facing settings are intentionally conservative:

- project to monitor;
- Start Once Monitor with Windows;
- meaningful notifications;
- attention notifications;
- observed-activity notifications;
- automatic local discovery;
- bounded refresh interval.

Monitor does not expose a casual global "Protection off" switch.

## Local snapshot contract

Monitor consumes:

```text
once-monitor snapshot [directory]
```

Schema:

```text
once.monitor.snapshot.v1
```

The snapshot is produced by the existing Once Tool Graph discovery engine and is explicitly local/read-only.

Allowed data includes:

- project basename;
- Node version;
- language/tooling names;
- aggregate counts;
- safe tool identity/name;
- framework when observed;
- evidence level;
- effect class;
- importance band;
- action priority;
- protection state;
- visibility booleans.

The snapshot privacy contract asserts:

```text
localReadOnly: true
sourceUploaded: false
secretValuesIncluded: false
payloadsIncluded: false
absolutePathsIncluded: false
```

The Windows client rejects a snapshot that does not satisfy that contract.

The CLI rejects live/network-style flags. Monitor does not probe MCP servers, invoke tools, or contact providers merely to populate the UI.

## Data that must not enter the Monitor snapshot

- API keys or credentials;
- prompts;
- tool arguments;
- tool results;
- error payloads;
- provider payloads;
- source snippets;
- tool descriptions/reason lists when they could expose application content;
- MCP command lines / args / env values;
- absolute project paths.

The local settings file necessarily stores the selected project path so Monitor can inspect that project. That path is not copied into the safe Monitor snapshot or sanitized support diagnostics.

## Notifications

Notifications must describe only evidence actually present.

Allowed examples:

- a tool-safety record newly needs attention;
- new execution evidence appeared in the local Tool Graph.

Monitor must not claim that a duplicate was suppressed, money was saved, or a side effect was prevented unless a future real event feed provides that evidence.

## Failure behavior

Monitor fails informationally, not executively.

If Node.js is unavailable, the project disappears, the Monitor-enabled SDK is missing, snapshot parsing fails, or local status times out:

- the tray moves to a problem state;
- the panel explains the local status issue;
- Once protection is not changed;
- Monitor does not guess missing data.

## Proof gate

Before Monitor changes merge:

- the secret-minimal snapshot regression must pass;
- the native Windows project must compile;
- the self-contained Windows executable must publish;
- the native self-test must pass;
- the Windows test MSIX must pack successfully when packaging changes are involved;
- existing SDK, Worker/runtime, MCP, and public-site safety suites must remain green on the exact PR head.

Public release/signing and npm publication are separate authorized release steps.
