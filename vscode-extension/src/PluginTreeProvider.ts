/* vscode-extension/src/PluginTreeProvider.ts
   Design ref: wixie/prompts/enchanter-monitor-redesign/prompt.md §2 + §6.
   - Microsoft VS Code UX: TreeView > Webview ("use sparingly").
   - Native ThemeIcon + ThemeColor; no hardcoded colors.

   Architecture-spec: Sidebar tree view "Plugins". 9 runtime plugins as
   top-level rows; each expands into the last 10 events for that plugin.
   Description = live counter summary; tooltip = sparkline + numbers. */

import * as vscode from 'vscode';
import type { StateStore } from './StateStore.js';
import type { InspectorState, PluginState, EnchantedEvent } from './types.js';

const RUNTIME_PLUGINS = [
  'pech', 'emu', 'hydra', 'sylph', 'lich', 'naga', 'crow', 'djinn', 'gorgon',
] as const;

class PluginItem extends vscode.TreeItem {
  constructor(public readonly plugin: PluginState) {
    super(plugin.name, vscode.TreeItemCollapsibleState.Collapsed);

    const status = plugin.lastStatus;
    const eventCount = plugin.recentEvents.length;
    this.description = `${eventCount} events · ${status}${plugin.degraded ? ' · degraded' : ''}`;
    this.tooltip = new vscode.MarkdownString(
      `**${plugin.name}**\n\n` +
      `last status: \`${status}\`\n\n` +
      `recent events: ${eventCount}\n\n` +
      (plugin.degraded ? '⚠ degraded\n\n' : '') +
      (plugin.required ? 'required plugin' : 'advisory plugin'),
    );

    if (status === 'veto' || status === 'error') {
      this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
    } else if (plugin.degraded) {
      this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
    } else if (status === 'ack') {
      this.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
    } else {
      this.iconPath = new vscode.ThemeIcon('circle-outline');
    }
    this.contextValue = 'plugin';
  }
}

class PluginEventItem extends vscode.TreeItem {
  constructor(ev: EnchantedEvent) {
    super(ev.topic, vscode.TreeItemCollapsibleState.None);
    const ts = new Date(ev.ts).toISOString().slice(11, 23);
    this.description = `${ts} · [${ev.phase}]`;
    this.tooltip = new vscode.MarkdownString(
      `**${ev.topic}**\n\n` +
      `\`\`\`\n` +
      `id:    ${ev.id}\n` +
      `corr:  ${ev.correlation_id}\n` +
      `phase: ${ev.phase}\n` +
      `tier:  ${ev.budget_tier}\n` +
      `\`\`\``,
    );
    const isVeto = ev.topic.includes('veto') || ev.topic.includes('drift');
    this.iconPath = new vscode.ThemeIcon(isVeto ? 'alert' : 'symbol-event');
    this.contextValue = 'pluginEvent';
  }
}

type PluginTreeNode = PluginItem | PluginEventItem;

export class PluginTreeProvider
  implements vscode.TreeDataProvider<PluginTreeNode>, vscode.Disposable
{
  private readonly _emitter = new vscode.EventEmitter<PluginTreeNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._emitter.event;

  private plugins: PluginState[] = [];
  private readonly unsub: () => void;

  constructor(store: StateStore) {
    this._sync(store.state);
    this.unsub = store.onChange((s) => {
      this._sync(s);
      this._emitter.fire();
    });
  }

  private _sync(s: InspectorState): void {
    this.plugins = RUNTIME_PLUGINS.map((name) =>
      s.plugins.get(name) ?? {
        name, lastStatus: 'unknown', degraded: false, required: false, recentEvents: [],
      });
  }

  getTreeItem(element: PluginTreeNode): vscode.TreeItem { return element; }

  getChildren(element?: PluginTreeNode): PluginTreeNode[] {
    if (!element) {
      return this.plugins.map((p) => new PluginItem(p));
    }
    if (element instanceof PluginItem) {
      return element.plugin.recentEvents.slice(0, 10).map((ev) => new PluginEventItem(ev));
    }
    return [];
  }

  refresh(): void { this._emitter.fire(); }

  dispose(): void {
    this.unsub();
    this._emitter.dispose();
  }
}
