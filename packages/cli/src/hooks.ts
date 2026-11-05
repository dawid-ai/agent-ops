import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { OpsError } from '@agent-ops/core';

export const SYNC_HOOK_COMMAND = 'ops sync --session-end';

/** Claude Code events that push the task store: the end of a session and context compaction. */
export const HOOK_EVENTS = ['SessionEnd', 'PreCompact'] as const;

/**
 * Seconds the hook may run. SessionEnd hooks share a 1.5 s budget unless a hook sets a longer
 * timeout, which raises it to at most 60 s; a commit, pull and push needs more than 1.5 s.
 */
export const SYNC_HOOK_TIMEOUT = 60;

interface HookCommand {
  type: string;
  command?: string;
  [key: string]: unknown;
}

interface HookGroup {
  matcher?: string;
  hooks?: HookCommand[];
  [key: string]: unknown;
}

type Settings = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> };

/** Adds the sync hook for each event unless it is already there. Other settings stay as they are. */
export function mergeClaudeHooks(settings: Settings): { settings: Settings; added: string[] } {
  const hooks: Record<string, HookGroup[]> = { ...(settings.hooks ?? {}) };
  const added: string[] = [];
  for (const event of HOOK_EVENTS) {
    let changed = false;
    // Hooks written before the timeout existed get it now.
    const groups = (hooks[event] ?? []).map((g) => ({
      ...g,
      hooks: g.hooks?.map((h) => {
        if (h.command !== SYNC_HOOK_COMMAND || h.timeout !== undefined) return h;
        changed = true;
        return { ...h, timeout: SYNC_HOOK_TIMEOUT };
      }),
    }));
    const present = groups.some((g) => g.hooks?.some((h) => h.command === SYNC_HOOK_COMMAND));
    if (!present) {
      groups.push({
        hooks: [{ type: 'command', command: SYNC_HOOK_COMMAND, timeout: SYNC_HOOK_TIMEOUT }],
      });
      changed = true;
    }
    if (changed) added.push(event);
    hooks[event] = groups;
  }
  return { settings: { ...settings, hooks }, added };
}

/** Writes the hooks into `<dir>/.claude/settings.json`, keeping everything else in the file. */
export function installClaudeHooks(dir: string): { file: string; added: string[] } {
  const file = join(dir, '.claude', 'settings.json');
  let current: Settings = {};
  if (existsSync(file)) {
    try {
      current = JSON.parse(readFileSync(file, 'utf8')) as Settings;
    } catch {
      throw new OpsError(`${file} is not valid JSON; fix it first, nothing was changed`, 2);
    }
  }
  const { settings, added } = mergeClaudeHooks(current);
  if (added.length > 0) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  }
  return { file, added };
}
