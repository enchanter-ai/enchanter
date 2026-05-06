#!/usr/bin/env node
/* scripts/hooks/install-hooks.mjs — one-shot installer for the Claude
 * Code → enchanter inspector wire-up.
 *
 * Adds entries under `hooks` in ~/.claude/settings.json so Claude Code
 * invokes scripts/hooks/claude-code-emit.mjs on each session lifecycle
 * event. Idempotent: re-running won't duplicate entries.
 *
 *   node scripts/hooks/install-hooks.mjs              # install
 *   node scripts/hooks/install-hooks.mjs --uninstall  # remove our entries
 *
 * Stdlib-only Node. Settings file is created if missing; existing
 * unrelated settings are preserved verbatim.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EMITTER = path.resolve(HERE, 'claude-code-emit.mjs');

const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
  'SessionEnd',
  'PreCompact',
];

const MARKER = 'enchanter:claude-code-emit'; // command substring we recognize

const argv = process.argv.slice(2);
const uninstall = argv.includes('--uninstall');
// `--silent` is for the npm postinstall path. Stay no-op-quiet when the
// user doesn't have Claude Code installed (`~/.claude/` directory is
// absent), so `npm install enchanter` doesn't print scary errors for
// users who only want the SDK/inspector and aren't using Claude Code.
const silent = argv.includes('--silent');

if (silent) {
  const claudeDir = path.join(os.homedir(), '.claude');
  if (!fs.existsSync(claudeDir)) {
    // No Claude Code installation detected — exit 0 silently.
    process.exit(0);
  }
}

function settingsPath() {
  const home = os.homedir();
  return path.join(home, '.claude', 'settings.json');
}

function cachePath() {
  const xdg = process.env.XDG_CACHE_HOME;
  let base;
  if (xdg && xdg.length > 0) base = xdg;
  else if (process.platform === 'win32' && process.env.LOCALAPPDATA)
    base = process.env.LOCALAPPDATA;
  else base = path.join(os.homedir(), '.cache');
  return path.join(base, 'enchanter', 'claude-code.jsonl');
}

function readSettings(p) {
  if (!fs.existsSync(p)) return {};
  try {
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`[install-hooks] failed to parse ${p}: ${err.message}\n`);
    process.exit(2);
  }
}

function writeSettings(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

// Build the command Claude Code will invoke. The marker comment makes our
// entries grep-able for idempotent re-installs and uninstalls.
function commandFor(eventName) {
  // Quote the path for safety on paths containing spaces. The shell that
  // Claude Code spawns the command in handles quoting.
  return `node "${EMITTER}" --event ${eventName} # ${MARKER}`;
}

function isOurs(entry) {
  if (!entry || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(
    (h) => h && typeof h.command === 'string' && h.command.includes(MARKER),
  );
}

function installInto(settings) {
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  let added = 0;
  let skipped = 0;
  for (const ev of HOOK_EVENTS) {
    const list = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
    if (list.some(isOurs)) {
      skipped++;
      settings.hooks[ev] = list;
      continue;
    }
    list.push({
      matcher: '*',
      hooks: [{ type: 'command', command: commandFor(ev) }],
    });
    settings.hooks[ev] = list;
    added++;
  }
  return { added, skipped };
}

function uninstallFrom(settings) {
  if (!settings.hooks || typeof settings.hooks !== 'object') return { removed: 0 };
  let removed = 0;
  for (const ev of HOOK_EVENTS) {
    const list = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
    const before = list.length;
    const filtered = list.filter((entry) => !isOurs(entry));
    removed += before - filtered.length;
    if (filtered.length === 0) delete settings.hooks[ev];
    else settings.hooks[ev] = filtered;
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return { removed };
}

// --------------------------------------------------------------------------
function main() {
  if (!fs.existsSync(EMITTER)) {
    process.stderr.write(
      `[install-hooks] emitter not found at ${EMITTER}\n` +
        `Did you run this from a checkout of the enchanter package?\n`,
    );
    process.exit(2);
  }
  const sp = settingsPath();
  const settings = readSettings(sp);

  if (uninstall) {
    const { removed } = uninstallFrom(settings);
    writeSettings(sp, settings);
    process.stdout.write(
      `[install-hooks] uninstalled ${removed} entr${removed === 1 ? 'y' : 'ies'} from ${sp}\n`,
    );
    return;
  }

  const { added, skipped } = installInto(settings);
  writeSettings(sp, settings);
  const out = cachePath();
  process.stdout.write(
    `[install-hooks] installed ${added} hook${added === 1 ? '' : 's'} ` +
      `(${skipped} already present) → ${sp}\n` +
      `JSONL stream: ${out}\n` +
      `Launch the inspector with: enchanter inspect --tail "${out}"\n`,
  );
}

main();
