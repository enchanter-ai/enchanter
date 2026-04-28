# Enchanter Inspector

Companion to the [Enchanter SDK](https://github.com/enchanter-ai/enchanter) · [GitHub](https://github.com/enchanter-ai/enchanter) · [Issues](https://github.com/enchanter-ai/enchanter/issues)

Native VS Code extension that connects to a running Enchanter dashboard-server
WebSocket and surfaces live MCP traffic and plugin events as three native
TreeViews plus a status-bar pill. No webview — pure VS Code primitives, fully
themed by the editor color scheme.

## Features

- **Activity-bar view container** — dedicated Enchanter side panel with three
  TreeViews:
  - **Plugins** — 9 runtime plugins (pech, emu, hydra, sylph, lich, naga, crow,
    djinn, gorgon). Each row expands into the last 10 events for that plugin.
  - **Events** — chronological flat list of the last 200 bus events; veto /
    drift events tagged with the alert icon.
  - **Phases** — 7 lifecycle phases (anchor → cross-session) tagged
    ✓ completed · ● current · — upcoming.
- **Status bar (right-aligned)** — compact aggregate
  `$(pulse) Enchanter · 47 events · 2 vetoes` with a markdown tooltip that
  links straight back to the terminal inspector.
- **Welcome view** — when not connected, a single panel offers
  *Open Terminal Inspector* and *Connect Manually...* actions.
- **Native theming** — every icon is a `ThemeIcon`, every accent a
  `ThemeColor`. The extension matches your editor theme automatically.

## Getting Started

1. Start the SDK in a terminal: `npm run inspect` (the boxed CLI inspector
   also starts the WebSocket broadcaster on port 3001).
2. The extension auto-connects to `ws://localhost:3001/ws`.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `enchanter.wsUrl` | `ws://localhost:3001/ws` | WebSocket URL of the broadcaster |
| `enchanter.autoConnect` | `true` | Connect automatically on activation |
| `enchanter.statusBar.show` | `true` | Show the aggregate pill in the status bar |

## Commands

| Command | Description |
|---------|-------------|
| `Enchanter: Connect to Broadcaster` | Manually connect / change the WS URL |
| `Enchanter: Disconnect` | Disconnect from the WebSocket server |
| `Enchanter: Open Terminal Inspector` | Spawn `npm run inspect` in a VS Code terminal |
| `Enchanter: Refresh Trees` | Re-render the three TreeViews |
| `Enchanter: Show Last Veto Reason` | Surface the most recent veto from cache |

## Architecture

`ws-client.ts` maintains the WebSocket connection. It feeds `StateStore`,
which is the single source of truth for the three TreeView providers and the
status bar. Read-only observer pattern — the extension never writes back to
the SDK.

## WebSocket Protocol

Connects to `ws://localhost:3001/ws`. Handles four message kinds:

- `hello` — server handshake, initialises plugin list and phase registry
- `snapshot` — full state sync (ledger, counts, active correlations)
- `event` — individual `EnchantedEvent` bus emission
- `ack` — plugin ACK/veto/error for a correlation

Reconnects automatically on disconnect: 3 attempts at 2 s / 4 s / 8 s backoff.
