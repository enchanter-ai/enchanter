/* vscode-extension/src/extension.ts
   Design ref: wixie/prompts/enchanter-monitor-redesign/prompt.md §2 + §6 + §7.
   - Microsoft VS Code UX: TreeViews + StatusBarItem only; webview removed
     ("should be used sparingly … come at the cost of performance &
     accessibility"). Welcome view shown when not connected.
   - Native theme: ThemeIcon + ThemeColor; no hardcoded colors.

   Architecture-spec: read-only observer pattern. StateStore is fed by
   ws-client; PluginTreeProvider, EventTreeProvider, PhaseTreeProvider are
   pure consumers; the status bar item shows the aggregate pill. */

import * as vscode from 'vscode';
import { WsClient } from './ws-client.js';
import { StateStore } from './StateStore.js';
import { EnchanterStatusBar } from './EnchanterStatusBar.js';
import { PluginTreeProvider } from './PluginTreeProvider.js';
import { EventTreeProvider } from './EventTreeProvider.js';
import { PhaseTreeProvider } from './PhaseTreeProvider.js';

export function activate(ctx: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration('enchanter');
  const wsUrl: string = config.get('wsUrl') ?? 'ws://localhost:3001/ws';
  const autoConnect: boolean = config.get('autoConnect') ?? true;
  const showStatusBar: boolean = config.get('statusBar.show') ?? true;

  const store    = new StateStore();
  const wsClient = new WsClient(wsUrl);

  const unsubMsg    = wsClient.onMessage((msg) => store.applyMessage(msg));
  const unsubStatus = wsClient.onStatus((connected, url) => {
    store.setConnected(connected, url);
    // Drive the WelcomeView visibility via the configured `when` clause:
    void vscode.commands.executeCommand('setContext', 'enchanter.connected', connected);
  });

  // Initialize the connected context-key (false at activate time).
  void vscode.commands.executeCommand('setContext', 'enchanter.connected', false);

  // UI consumers
  const statusBar      = showStatusBar ? new EnchanterStatusBar(store) : null;
  const pluginProvider = new PluginTreeProvider(store);
  const eventProvider  = new EventTreeProvider(store);
  const phaseProvider  = new PhaseTreeProvider(store);

  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider('enchanterPlugins', pluginProvider),
    vscode.window.registerTreeDataProvider('enchanterEvents',  eventProvider),
    vscode.window.registerTreeDataProvider('enchanterPhases',  phaseProvider),
  );

  if (autoConnect) wsClient.connect();

  // ── Commands ──────────────────────────────────────────────────────────────

  const connectCmd = vscode.commands.registerCommand('enchanter.connect', async () => {
    const current = wsClient.currentUrl;
    const input = await vscode.window.showInputBox({
      prompt: 'Enchanter WebSocket URL',
      value: current,
      placeHolder: 'ws://localhost:3001/ws',
    });
    if (input !== undefined) {
      wsClient.connect(input.trim() || current);
      vscode.window.showInformationMessage(`Enchanter: connecting to ${input || current}`);
    }
  });

  const disconnectCmd = vscode.commands.registerCommand('enchanter.disconnect', () => {
    wsClient.disconnect();
    vscode.window.showInformationMessage('Enchanter: disconnected.');
  });

  const refreshTrees = vscode.commands.registerCommand('enchanter.refreshTrees', () => {
    pluginProvider.refresh();
    eventProvider.refresh();
    phaseProvider.refresh();
  });

  // §2 spec: open the terminal inspector via `npm run inspect`. Spawned in a
  // VS Code Terminal so the user sees the boxed CLI inline with their editor.
  const openTerminal = vscode.commands.registerCommand('enchanter.openTerminalInspector', () => {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const term = vscode.window.createTerminal({
      name: 'Enchanter Inspector',
      cwd: folder,
    });
    term.show(true);
    term.sendText('npm run inspect', true);
  });

  // §2 commands surface — show last veto reason from current state cache.
  const showLastVeto = vscode.commands.registerCommand('enchanter.showLastVeto', () => {
    const evs = store.state.recentEvents;
    const veto = evs.find((e) => e.topic.includes('veto'));
    if (!veto) {
      vscode.window.showInformationMessage('Enchanter: no recent veto in cache.');
      return;
    }
    const p = veto.payload as Record<string, unknown>;
    const pat = typeof p['pattern_id'] === 'string' ? p['pattern_id'] : '(unknown)';
    vscode.window.showWarningMessage(
      `Enchanter veto: ${veto.topic} · pattern=${pat}`,
    );
  });

  // ── Listen for config changes ─────────────────────────────────────────────

  const cfgWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('enchanter.wsUrl')) {
      const updated = vscode.workspace.getConfiguration('enchanter').get<string>('wsUrl');
      if (updated) wsClient.connect(updated);
    }
  });

  // ── Cleanup ───────────────────────────────────────────────────────────────

  ctx.subscriptions.push(
    connectCmd, disconnectCmd, refreshTrees, openTerminal, showLastVeto,
    pluginProvider, eventProvider, phaseProvider,
    cfgWatcher,
    { dispose: () => { unsubMsg(); unsubStatus(); wsClient.disconnect(); } },
  );
  if (statusBar) ctx.subscriptions.push(statusBar);
}

export function deactivate(): void { /* subscriptions handle cleanup */ }
