/* vscode-extension/src/EventTreeProvider.ts
   Design ref: wixie/prompts/enchanter-monitor-redesign/prompt.md §2.
   - Microsoft VS Code UX: TreeView with native ThemeIcons, no hardcoded color.

   Architecture-spec: Sidebar tree view "Events". Chronological flat list of
   the last N bus events; veto / drift events tagged with the alert icon. */

import * as vscode from 'vscode';
import type { StateStore } from './StateStore.js';
import type { InspectorState, EnchantedEvent } from './types.js';

class BusEventItem extends vscode.TreeItem {
  constructor(ev: EnchantedEvent) {
    super(ev.topic, vscode.TreeItemCollapsibleState.None);
    const ts = new Date(ev.ts).toISOString().slice(11, 23);
    const summary = summarize(ev.payload);
    this.description = `${ts} · ${summary}`;
    this.tooltip = new vscode.MarkdownString(
      `**${ev.topic}**\n\n` +
      `\`\`\`\n` +
      `id:    ${ev.id}\n` +
      `corr:  ${ev.correlation_id}\n` +
      `phase: ${ev.phase}\n` +
      `src:   ${ev.source}\n` +
      `tier:  ${ev.budget_tier}\n` +
      `\`\`\``,
    );
    const isAlert = ev.topic.includes('veto') ||
                    ev.topic.includes('drift') ||
                    ev.topic.includes('suspicion');
    if (isAlert) {
      this.iconPath = new vscode.ThemeIcon('alert', new vscode.ThemeColor('errorForeground'));
    } else {
      this.iconPath = new vscode.ThemeIcon('info');
    }
    this.contextValue = 'busEvent';
  }
}

function summarize(payload: Readonly<Record<string, unknown>>): string {
  if (!payload) return '';
  if (typeof payload['pattern_id'] === 'string') return `p=${payload['pattern_id']}`;
  if (typeof payload['tool'] === 'string')       return `t=${payload['tool']}`;
  if (typeof payload['vendor'] === 'string')     return `v=${payload['vendor']}`;
  return '';
}

export class EventTreeProvider
  implements vscode.TreeDataProvider<BusEventItem>, vscode.Disposable
{
  private readonly _emitter = new vscode.EventEmitter<BusEventItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._emitter.event;

  private events: EnchantedEvent[] = [];
  private readonly unsub: () => void;

  constructor(store: StateStore) {
    this._sync(store.state);
    this.unsub = store.onChange((s) => {
      this._sync(s);
      this._emitter.fire();
    });
  }

  private _sync(s: InspectorState): void {
    this.events = [...s.recentEvents].slice(0, 200);
  }

  getTreeItem(element: BusEventItem): vscode.TreeItem { return element; }

  getChildren(element?: BusEventItem): BusEventItem[] {
    if (element) return [];
    return this.events.map((ev) => new BusEventItem(ev));
  }

  refresh(): void { this._emitter.fire(); }

  dispose(): void {
    this.unsub();
    this._emitter.dispose();
  }
}
