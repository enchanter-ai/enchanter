/* vscode-extension/src/EnchanterStatusBar.ts
   Design ref: wixie/prompts/enchanter-monitor-redesign/prompt.md §2.
   - Microsoft VS Code UX: StatusBar item, right-aligned (workspace-scoped).
   - Compact aggregate: events / vetoes / spent. Click → focus Plugins tree.

   Architecture-spec: at-a-glance health pill driven by the same StateStore
   that backs the three TreeViews; updates on every event. */

import * as vscode from 'vscode';
import type { StateStore } from './StateStore.js';
import type { InspectorState } from './types.js';

export class EnchanterStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly unsub: () => void;

  constructor(store: StateStore) {
    // Right-aligned: per spec §2, workspace-scoped pills go on the right.
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.command = 'enchanter.openTerminalInspector';
    this._update(store.state);
    this.item.show();

    this.unsub = store.onChange((s) => this._update(s));
  }

  private _update(s: InspectorState): void {
    if (!s.connected) {
      this.item.text = '$(plug) Enchanter · disconnected';
      this.item.tooltip = new vscode.MarkdownString(
        '**Enchanter — not connected**\n\n' +
        'Run `npm run inspect` in a terminal, then use\n' +
        '`Enchanter: Connect to Broadcaster` to attach.',
      );
      this.item.backgroundColor = undefined;
      return;
    }

    const ev = s.busEventCount;
    const vt = s.vetoCount;
    const ms = s.maskCount;

    const vetoChunk = vt > 0 ? ` · ${vt} vetoes` : '';
    this.item.text = `$(pulse) Enchanter · ${ev} events${vetoChunk}`;
    this.item.tooltip = new vscode.MarkdownString(
      `**Enchanter Inspector**\n\n` +
      `events: \`${ev}\`\n\n` +
      `vetoes: \`${vt}\`\n\n` +
      `secrets masked: \`${ms}\`\n\n` +
      `phase: \`${s.currentPhase ?? 'idle'}\`\n\n` +
      `tier: \`${s.currentTier ?? '—'}\`\n\n` +
      `[Open Terminal Inspector](command:enchanter.openTerminalInspector)`,
    );
    this.item.tooltip.isTrusted = true;

    if (vt > 0) {
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.item.backgroundColor = undefined;
    }
  }

  dispose(): void {
    this.unsub();
    this.item.dispose();
  }
}
