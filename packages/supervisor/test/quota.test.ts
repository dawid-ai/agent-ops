import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claudeUsage,
  codexUsage,
  findRollout,
  lastCodexLimits,
  mergeUsage,
  opsdConfig,
  roleLimits,
  UsageMeter,
  usagePause,
} from '../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = Date.parse('2026-11-01T12:00:00Z');
const RESET = NOW / 1000 + 3600;

describe('provider usage', () => {
  it("reads Claude Code's rate limit event", () => {
    // The shape a real run printed on 2026-11-01.
    const info = {
      status: 'allowed',
      resetsAt: RESET,
      rateLimitType: 'seven_day',
      overageStatus: 'rejected',
      isUsingOverage: false,
      unifiedWindows: { seven_day: { utilization: 0.38, resetsAt: RESET, status: 'allowed' } },
    };
    expect(claudeUsage(info, NOW)).toEqual({
      windows: { seven_day: { utilization: 0.38, resets_at: RESET * 1000, status: 'allowed' } },
      updated_at: NOW,
    });
    const refused = claudeUsage(
      { status: 'rejected', resetsAt: RESET, rateLimitType: 'five_hour' },
      NOW,
    );
    expect(refused?.limited_until).toBe(RESET * 1000);
    expect(refused?.windows.five_hour?.utilization).toBe(1);
    expect(claudeUsage(null, NOW)).toBeNull();
  });

  it("reads Codex's rate limits and finds the session file of a thread", () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-home-'));
    dirs.push(home);
    const day = join(home, 'sessions', '2026', '11', '01');
    mkdirSync(day, { recursive: true });
    const thread = '01a19603-74d3-7b71-b922-3d39b02cd404';
    const limits = {
      limit_id: 'codex',
      primary: { used_percent: 14.0, window_minutes: 10080, resets_at: RESET },
      secondary: null,
      plan_type: 'pro',
      rate_limit_reached_type: null,
    };
    const file = join(day, `rollout-2026-11-01T14-29-32-${thread}.jsonl`);
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session_meta', payload: { id: thread } }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'token_count', rate_limits: limits },
        }),
        '',
      ].join('\n'),
    );
    writeFileSync(join(day, 'rollout-2026-11-01T10-00-00-other.jsonl'), '');
    expect(findRollout(home, thread)).toBe(file);
    expect(findRollout(home, 'missing')).toBeNull();
    const read = lastCodexLimits(file);
    expect(codexUsage(read, NOW)).toEqual({
      windows: { seven_day: { utilization: 0.14, resets_at: RESET * 1000 } },
      plan: 'pro',
      updated_at: NOW,
    });
    const hit = codexUsage(
      {
        primary: { used_percent: 40, window_minutes: 300, resets_at: RESET - 600 },
        secondary: { used_percent: 100, window_minutes: 10080, resets_at: RESET },
        rate_limit_reached_type: 'secondary',
      },
      NOW,
    );
    expect(hit?.limited_until).toBe(RESET * 1000);
  });

  it('pauses a provider at the threshold until the window resets', () => {
    const u = {
      windows: {
        five_hour: { utilization: 0.5, resets_at: NOW + 60_000 },
        seven_day: { utilization: 0.92, resets_at: NOW + 3_600_000 },
      },
      updated_at: NOW,
    };
    expect(usagePause('claude', u, 0.9, NOW)).toMatch(
      /claude usage at 92% of the seven_day window \(pause at 90%\) until 2026-11-01 13:00 UTC/,
    );
    expect(usagePause('claude', u, 0.95, NOW)).toBeNull();
    expect(usagePause('claude', u, 0.9, NOW + 3_600_000)).toBeNull();
    expect(usagePause('claude', undefined, 0.9, NOW)).toBeNull();
    const merged = mergeUsage(u, {
      windows: { seven_day: { utilization: 0.2, resets_at: NOW + 99 } },
      updated_at: NOW + 1,
    });
    expect(merged.windows.five_hour?.utilization).toBe(0.5);
    expect(merged.windows.seven_day?.utilization).toBe(0.2);
  });

  it('defaults role limits by whether the role writes, and checks the threshold setting', () => {
    const cfg = opsdConfig({
      opsd: { roles: { engineer: { per_project: 2 }, docs: { writes: false } } },
    });
    expect(roleLimits(cfg, 'engineer')).toMatchObject({
      writes: true,
      per_project: 2,
      burst: 2,
      overflow: true,
      providers: ['claude', 'codex'],
    });
    expect(roleLimits(cfg, 'qa')).toMatchObject({ per_project: 3, burst: 6 });
    expect(roleLimits(cfg, 'qa')).toMatchObject({ writes: false, per_project: 3 });
    expect(roleLimits(cfg, 'docs')).toMatchObject({ writes: false, per_project: 3 });
    // The orchestrator only reads code, and one run of it is live at a time unless set.
    expect(roleLimits(cfg, 'orchestrator')).toMatchObject({ writes: false, max_live: 1 });
    expect(
      roleLimits(
        opsdConfig({ opsd: { roles: { orchestrator: { max_live: 2 } } } }),
        'orchestrator',
      ),
    ).toMatchObject({ writes: false, max_live: 2 });
    expect(cfg.max_runs).toBeGreaterThanOrEqual(1);
    expect(() => opsdConfig({ opsd: { usage_pause_at: 90 } })).toThrow(/usage_pause_at/);
    // A malformed number would turn a limit off, so it is refused.
    expect(() => opsdConfig({ opsd: { max_runs: 'many' as unknown as number } })).toThrow(
      /max_runs/,
    );
    expect(() => opsdConfig({ opsd: { min_free_gb: 'x' as unknown as number } })).toThrow(
      /min_free_gb/,
    );
    expect(() => opsdConfig({ opsd: { roles: { qa: { per_project: -1 } } } })).toThrow(
      /per_project/,
    );
    expect(() => opsdConfig({ opsd: { roles: { qa: { max_live: 1.5 } } } })).toThrow(/max_live/);
    expect(() =>
      opsdConfig({
        opsd: {
          runtimes: { claude: { command: 'claude', max_live: 'lots' as unknown as number } },
        },
      }),
    ).toThrow(/runtimes.claude.max_live/);
    expect(opsdConfig({ opsd: { max_runs: 0 } }).max_runs).toBe(0);
    expect(() => opsdConfig({ opsd: { review_backlog: 0 } })).toThrow(/review_backlog/);
    expect(() =>
      opsdConfig({ opsd: { roles: { qa: { burst: 'x' as unknown as number } } } }),
    ).toThrow(/roles.qa.burst/);
    expect(() =>
      opsdConfig({ opsd: { roles: { qa: { overflow: 'no' as unknown as boolean } } } }),
    ).toThrow(/roles.qa.overflow/);
    expect(() =>
      opsdConfig({ opsd: { roles: { qa: { providers: 'claude' as unknown as string[] } } } }),
    ).toThrow(/roles.qa.providers/);
    expect(() =>
      opsdConfig({ opsd: { runtimes: { claude: { command: 'claude', pause_at: 0 } } } }),
    ).toThrow(/pause_at/);
  });
});

describe('usage-limit errors in run output', () => {
  it("reads Claude Code's and Codex's limit errors, and ignores ordinary text", () => {
    const claude = new UsageMeter();
    claude.feed(
      JSON.stringify({
        type: 'result',
        is_error: true,
        result: 'Claude AI usage limit reached|1793811600',
        usage: { input_tokens: 5, output_tokens: 1 },
      }) + '\n',
    );
    expect(claude.limitHit).toEqual({ resetsAt: 1_793_811_600_000 });
    expect(claude.tokens).toBe(6);
    const codex = new UsageMeter();
    codex.feed(
      JSON.stringify({ type: 'error', message: "You've hit your usage limit. Try again later." }) +
        '\n',
    );
    codex.feed(JSON.stringify({ type: 'turn.failed', error: { message: 'stream error' } }) + '\n');
    expect(codex.limitHit).toEqual({});
    expect(codex.limitHits).toBe(1);
    const plain = new UsageMeter();
    plain.feed('Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}\n');
    expect(plain.limitHits).toBe(1);
    const quiet = new UsageMeter();
    quiet.feed(
      JSON.stringify({
        type: 'assistant',
        message: { content: 'the usage limit reached its cap in docs' },
      }) + '\n',
    );
    quiet.feed('we talk about usage limits here\n');
    expect(quiet.limitHits).toBe(0);
  });
});

describe('usage-limit errors and readings together', () => {
  it('counts only error lines and structured errors, never prose', () => {
    const prose = new UsageMeter();
    prose.feed('The usage limit reached its cap yesterday, the agent said.\n');
    expect(prose.limitHits).toBe(0);
    const line = new UsageMeter();
    line.feed('API Error: Claude AI usage limit reached|1793811600\n');
    expect(line.limitHit).toEqual({ resetsAt: 1_793_811_600_000 });
    const structured = new UsageMeter();
    structured.feed(
      JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }) +
        '\n',
    );
    expect(structured.limitHits).toBe(1);
  });

  it('lets a provider reading clear or replace a pause from an error', () => {
    const paused = { windows: {}, limited_until: NOW + 30 * 60_000, updated_at: NOW };
    const allowed = claudeUsage(
      {
        status: 'allowed',
        resetsAt: RESET,
        rateLimitType: 'seven_day',
        unifiedWindows: { seven_day: { utilization: 0.4, resetsAt: RESET } },
      },
      NOW + 1,
    )!;
    expect(mergeUsage(paused, allowed).limited_until).toBeUndefined();
    const rejected = claudeUsage(
      { status: 'rejected', resetsAt: RESET + 7200, rateLimitType: 'five_hour' },
      NOW + 2,
    )!;
    expect(mergeUsage(paused, rejected).limited_until).toBe((RESET + 7200) * 1000);
    // A reading without a refusal key (an error fallback built elsewhere) keeps the old one.
    expect(mergeUsage(paused, { windows: {}, updated_at: NOW + 3 }).limited_until).toBe(
      paused.limited_until,
    );
  });
});
