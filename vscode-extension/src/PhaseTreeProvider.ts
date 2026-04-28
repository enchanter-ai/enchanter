/* vscode-extension/src/PhaseTreeProvider.ts
   Design ref: wixie/prompts/enchanter-monitor-redesign/prompt.md §2.
   - Microsoft VS Code UX: third TreeView for the 7-phase orchestrator
     lifecycle (ADR-001).

   Architecture-spec: Sidebar tree view "Phases". 7 phase rows; each shows
   ✓ completed · ● current · — upcoming. */

import * as vscode from 'vscode';
import type { StateStore } from './StateStore.js';
import type { InspectorState, LifecyclePhase } from './types.js';
import { LIFECYCLE_PHASES } from './types.js';

type PhaseStatus = 'completed' | 'current' | 'upcoming';

const PHASE_DESC: Record<PhaseStatus, string> = {
  completed: '✓ completed',
  current:   '● current',
  upcoming:  '— upcoming',
};

class PhaseItem extends vscode.TreeItem {
  constructor(public readonly phase: LifecyclePhase, status: PhaseStatus) {
    super(phase, vscode.TreeItemCollapsibleState.None);
    this.description = PHASE_DESC[status];
    this.tooltip = `phase: ${phase} (${status})`;
    if (status === 'current') {
      this.iconPath = new vscode.ThemeIcon('debug-start', new vscode.ThemeColor('charts.yellow'));
    } else if (status === 'completed') {
      this.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
    } else {
      this.iconPath = new vscode.ThemeIcon('circle-outline');
    }
    this.contextValue = 'phase';
  }
}

export class PhaseTreeProvider
  implements vscode.TreeDataProvider<PhaseItem>, vscode.Disposable
{
  private readonly _emitter = new vscode.EventEmitter<PhaseItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._emitter.event;

  private currentPhase: LifecyclePhase | null = null;
  private readonly unsub: () => void;

  constructor(store: StateStore) {
    this._sync(store.state);
    this.unsub = store.onChange((s) => {
      this._sync(s);
      this._emitter.fire();
    });
  }

  private _sync(s: InspectorState): void {
    this.currentPhase = s.currentPhase;
  }

  getTreeItem(element: PhaseItem): vscode.TreeItem { return element; }

  getChildren(element?: PhaseItem): PhaseItem[] {
    if (element) return [];
    const cur = this.currentPhase;
    const curIdx = cur ? LIFECYCLE_PHASES.indexOf(cur) : -1;
    return LIFECYCLE_PHASES.map((phase, i) => {
      let status: PhaseStatus = 'upcoming';
      if (curIdx >= 0) {
        if (i < curIdx)        status = 'completed';
        else if (i === curIdx) status = 'current';
      }
      return new PhaseItem(phase as LifecyclePhase, status);
    });
  }

  refresh(): void { this._emitter.fire(); }

  dispose(): void {
    this.unsub();
    this._emitter.dispose();
  }
}
