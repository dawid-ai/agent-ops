// AO-0140: every task that can run has an owner. Ownerless work goes to a role group picked from
// its type and labels; `ops new` and `ops assign` refuse owners no run would pick up.
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UserConfig } from '../src/index.js';
import { roleGroupFor } from '../src/index.js';
import { setup } from './helpers.js';

function roleFile(rootDir: string, slug: string, status = 'active', canClaim?: string[]): void {
  mkdirSync(join(rootDir, 'agents'), { recursive: true });
  const claim = canClaim ? `can_claim: [${canClaim.join(', ')}]\n` : '';
  writeFileSync(join(rootDir, 'agents', `${slug}.md`), `---\nstatus: ${status}\n${claim}---\n`);
}

/** A user config whose opsd section wakes these agents, with these role limits. */
function waking(ids: string[], roles: Record<string, unknown> = {}): UserConfig {
  return {
    opsd: { agents: Object.fromEntries(ids.map((id) => [id, { wake: true }])), roles },
  } as UserConfig;
}

describe('type-to-role map', () => {
  it('picks the role group from the type, then the labels, then engineers', () => {
    expect(roleGroupFor('bug')).toBe('*:engineer');
    expect(roleGroupFor('feature')).toBe('*:engineer');
    expect(roleGroupFor('task')).toBe('*:engineer');
    expect(roleGroupFor('test')).toBe('*:qa');
    expect(roleGroupFor('qa')).toBe('*:qa');
    expect(roleGroupFor('review')).toBe('*:reviewer');
    expect(roleGroupFor('question')).toBe('*:pm');
    // A plain task, or a type the map does not name, goes by its labels.
    expect(roleGroupFor('task', ['ui', 'QA'])).toBe('*:qa');
    expect(roleGroupFor('chore', ['review'])).toBe('*:reviewer');
    expect(roleGroupFor('chore', ['ui'])).toBe('*:engineer');
    // A type the map names wins over its labels.
    expect(roleGroupFor('bug', ['qa'])).toBe('*:engineer');
  });
});

describe('routes for ownerless work', () => {
  it('routes accepted findings and unconfigured owners, never untriaged findings or ideas', () => {
    const { as, rootDir } = setup();
    roleFile(rootDir, 'claude-engineer');
    // qa is a read-only role: it takes test work only when its role file allows it (AO-0136).
    roleFile(rootDir, 'codex-qa', 'active', ['test', 'question']);
    const h = as('human:dawid', { force: true });
    h.newTask({ title: 'start' });
    as('claude:engineer').start('1');
    const finding = as('claude:engineer').finding({ title: 'Login retries', task: '1' }).meta;
    const test = h.newTask({ title: 'cover login', type: 'test' });
    const release = h.newTask({ title: 'release', owner: 'claude:release' });
    const idea = h.newTask({ title: 'later', type: 'idea' });
    const mine = h.newTask({ title: 'mine', owner: 'human:dawid' });
    const owned = h.newTask({ title: 'owned', owner: 'claude:engineer' });

    const ws = as('opsd:router');
    const ids = (wake: string[]) =>
      ws
        .routes(wake)
        .filter((r) => !r.blocker)
        .map((r) => [r.view.meta.id, r.to]);
    // The finding waits for triage; ideas, people's tasks and configured owners need no route.
    expect(ids(['claude:engineer', 'codex:qa'])).toEqual([
      [test.id, '*:qa'],
      [release.id, '*:engineer'],
    ]);
    h.retype(finding.id, 'bug', 'Accepted in triage');
    expect(ids(['claude:engineer', 'codex:qa'])).toContainEqual([finding.id, '*:engineer']);

    // Without a waking qa agent the test task stays as it is, with the reason.
    const blocked = ws.routes(['claude:engineer']).find((r) => r.view.meta.id === test.id);
    expect(blocked?.blocker).toBe('no waking agent answers to *:qa');
    expect(ids(['claude:engineer']).map(([id]) => id)).not.toContain(test.id);
    for (const id of [idea.id, mine.id, owned.id]) {
      expect(ws.routes(['claude:engineer']).map((r) => r.view.meta.id)).not.toContain(id);
    }
  });

  it('records the route as an assign event from opsd with the reason, once', () => {
    const { as } = setup();
    const h = as('human:dawid');
    const t = h.newTask({ title: 'fix', type: 'bug' });
    expect(() => as('claude:engineer').route(t.id, '*:engineer', 'x')).toThrow(/only opsd/);

    const ws = as('opsd:router');
    const [r] = ws.routes(['claude:engineer']);
    expect(r?.reason).toBe(`${t.id} has no owner; opsd routes bug work to *:engineer`);
    const res = ws.route(t.id, r!.to, r!.reason);
    expect(res.view.owner).toBe('*:engineer');
    expect(res.events).toMatchObject([
      { type: 'assign', actor: 'opsd:router', to: '*:engineer', body: r!.reason },
    ]);
    // An owner set meanwhile stays: the route is checked again under the task lock.
    expect(() => ws.route(t.id, '*:qa', 'again')).toThrow(/needs no route/);
    expect(ws.routes(['claude:engineer'])).toEqual([]);
  });

  it('keeps a blocked task waiting when it routes it', () => {
    const { as } = setup();
    const h = as('human:dawid');
    const dep = h.newTask({ title: 'dep' });
    const t = h.newTask({ title: 'after', blockedBy: [dep.id] });
    const ws = as('opsd:router');
    const r = ws.routes(['claude:engineer']).find((x) => x.view.meta.id === t.id)!;
    const res = ws.route(t.id, r.to, r.reason);
    expect(res.view.owner).toBe('*:engineer');
    expect(res.view.status).toBe('blocked');
    expect(res.view.blockedOn).toEqual([dep.id]);
  });

  it('routes a claimed task once its lease runs out and its agent is gone', () => {
    const { as, rootDir } = setup();
    roleFile(rootDir, 'claude-engineer');
    roleFile(rootDir, 'claude-backend');
    roleFile(rootDir, 'codex-qa', 'active', ['test']);
    const h = as('human:dawid');
    const claimed = h.newTask({ title: 'claimed', owner: 'claude:backend' });
    const started = h.newTask({ title: 'started', type: 'test', owner: 'claude:backend' });
    as('claude:backend').claim(claimed.id);
    as('claude:backend').start(started.id);
    // The agent is removed after it claimed the work.
    unlinkSync(join(rootDir, 'agents', 'claude-backend.md'));

    // A live claim still holds the work: opsd leaves it with its agent.
    expect(as('opsd:router').routes(['claude:engineer', 'codex:qa'])).toEqual([]);

    // Past the 4 h work lease, so both claims have run out.
    const later = Date.now() + 241 * 60_000;
    const ws = as('opsd:router', { now: () => later });
    const routes = ws.routes(['claude:engineer', 'codex:qa']);
    expect(routes.map((r) => [r.view.meta.id, r.to, r.blocker])).toEqual([
      [claimed.id, '*:engineer', undefined],
      [started.id, '*:qa', undefined],
    ]);
    expect(routes[0]!.reason).toBe(
      'owner claude:backend is not a configured agent; opsd routes task work to *:engineer',
    );
    for (const r of routes) {
      const res = ws.route(r.view.meta.id, r.to, r.reason);
      expect(res.view).toMatchObject({
        owner: r.to,
        status: 'todo',
        claimedBy: null,
        stale: false,
      });
    }
    expect(ws.routes(['claude:engineer', 'codex:qa'])).toEqual([]);
  });

  it('routes only to a group with a waking agent opsd would start on the task', () => {
    const { as, rootDir } = setup();
    roleFile(rootDir, 'fake-engineer');
    roleFile(rootDir, 'codex-qa');
    const h = as('human:dawid');
    const bug = h.newTask({ title: 'fix', type: 'bug' });
    const test = h.newTask({ title: 'cover', type: 'test' });
    const ws = as('opsd:router');
    const blockers = (limits: Record<string, { providers: string[]; overflow: boolean }>) =>
      new Map(
        ws
          .routes(['fake:engineer', 'codex:qa'], (a) => limits[a.split(':')[1]!]!)
          .map((r) => [r.view.meta.id, r.blocker]),
      );
    const open = { providers: ['fake', 'codex'], overflow: true };
    // Engineers are limited to another provider: wake would start no fake:engineer run.
    expect(
      blockers({ engineer: { providers: ['other'], overflow: true }, qa: open }).get(bug.id),
    ).toBe(
      'no waking agent of *:engineer is one of its providers (opsd.roles.engineer.providers, overflow)',
    );
    // Without overflow only the first provider takes the work.
    expect(
      blockers({ engineer: { providers: ['other', 'fake'], overflow: false }, qa: open }).get(
        bug.id,
      ),
    ).toMatch(/is one of its providers/);
    expect(
      blockers({ engineer: { providers: ['other', 'fake'], overflow: true }, qa: open }).get(
        bug.id,
      ),
    ).toBeUndefined();
    // qa is read-only and its role file allows no test work, so no qa run would claim it.
    expect(blockers({ engineer: open, qa: open }).get(test.id)).toBe(
      'no waking agent of *:qa may claim test work (can_claim)',
    );
  });

  it('never routes to a group whose only waking provider is the expected reviewer', () => {
    const { as, rootDir } = setup();
    roleFile(rootDir, 'claude-backend');
    roleFile(rootDir, 'claude-engineer');
    roleFile(rootDir, 'codex-engineer');
    roleFile(rootDir, 'codex-qa');
    const h = as('human:dawid');
    const t = h.newTask({ title: 'fix', type: 'bug' });
    h.delegate(t.id, 'claude:backend', { review: 'codex:qa' });
    // The delegate is removed; the routing assign keeps the delegation and its reviewer.
    unlinkSync(join(rootDir, 'agents', 'claude-backend.md'));

    const ws = as('opsd:router');
    const route = (wake: string[]) => ws.routes(wake).find((r) => r.view.meta.id === t.id);
    // Wake never starts a codex run on work a codex agent reviews, so the task stays.
    expect(route(['codex:engineer'])?.blocker).toBe(
      'every waking provider of *:engineer is the provider of the expected reviewer codex:qa',
    );
    expect(route(['codex:engineer', 'claude:engineer'])?.blocker).toBeUndefined();
  });

  it('reads the role providers from the user config by default', () => {
    const { as, rootDir } = setup();
    roleFile(rootDir, 'fake-engineer');
    const h = as('human:dawid');
    const bug = h.newTask({ title: 'fix', type: 'bug' });
    const user = waking(['fake:engineer'], { engineer: { providers: ['other'] } });
    const ws = as('opsd:router', { user });
    expect(ws.groupProviders('fake:engineer')).toEqual({ providers: ['other'], overflow: true });
    expect(ws.routes().find((r) => r.view.meta.id === bug.id)?.blocker).toMatch(
      /is one of its providers/,
    );
    // Without a list, every runtime opsd knows: the defaults until the config is seeded.
    expect(
      as('opsd:router', { user: waking(['fake:engineer']) }).groupProviders('fake:qa'),
    ).toEqual({ providers: ['claude', 'codex'], overflow: true });
    const seeded = { opsd: { seeded: 1, runtimes: { fake: { command: 'fake' } } } } as UserConfig;
    expect(as('opsd:router', { user: seeded }).groupProviders('fake:qa').providers).toEqual([
      'fake',
    ]);
  });
});

describe('owners ops new and ops assign refuse', () => {
  it('refuses a role group no waking agent answers to, and suggests owners that take work', () => {
    const { as, rootDir } = setup();
    roleFile(rootDir, 'claude-engineer');
    roleFile(rootDir, 'codex-pm');
    roleFile(rootDir, 'claude-writer', 'paused');
    const user = waking(['claude:engineer', 'codex:pm', 'claude:writer']);
    const h = as('human:dawid', { user });
    expect(h.ownerRefusal('*:engineer')).toBeNull();
    expect(h.ownerRefusal('claude:*')).toBeNull();
    expect(h.ownerRefusal('human:anna')).toBeNull();
    expect(h.ownerRefusal('codex:pm')).toBeNull();
    // A paused role does not wake, so its group reaches no run.
    expect(h.ownerRefusal('*:writer')).toBe('*:writer matches no waking agent');
    expect(h.ownerRefusal('*:release')).toBe('*:release matches no waking agent');
    expect(h.ownerRefusal('claude:release')).toBe('claude:release is not a configured agent');

    expect(() => h.newTask({ title: 'x', owner: '*:release' })).toThrow(
      'owner *:release matches no waking agent, so no run picks it up; use a role group ' +
        '(*:engineer, *:pm), or a configured agent (claude:engineer, claude:writer, codex:pm), ' +
        'or human:dawid (use --force to override)',
    );
    const t = h.newTask({ title: 'x', owner: '*:engineer' });
    expect(() => h.assign(t.id, '*:writer')).toThrow(/owner \*:writer matches no waking agent/);
    expect(() => h.assign(t.id, 'claude:release')).toThrow(/not a configured agent/);
    expect(h.assign(t.id, '*:pm').view.owner).toBe('*:pm');
    const forced = as('human:dawid', { user, force: true }).assign(t.id, '*:release');
    expect(forced.view.owner).toBe('*:release');
    expect(forced.warnings).toEqual([
      'owner *:release matches no waking agent: no run picks it up',
    ]);
  });

  it('refuses a role group whose waking agents are not among its providers', () => {
    const { as, rootDir } = setup();
    roleFile(rootDir, 'fake-engineer');
    const user = waking(['fake:engineer'], { engineer: { providers: ['other'] } });
    const h = as('human:dawid', { user });
    expect(h.ownerRefusal('*:engineer')).toBe(
      "*:engineer matches no waking agent of the role's providers (opsd.roles.engineer.providers, overflow)",
    );
    // A provider group is not limited by role providers, as in the wake planner.
    expect(h.ownerRefusal('fake:*')).toBeNull();
    expect(() => h.newTask({ title: 'x', owner: '*:engineer' })).toThrow(/role's providers/);
    // The refusal does not suggest the group it just refused: no role group takes work here.
    expect(h.ownerSuggestions()).toBe('use a configured agent (fake:engineer), or human:dawid');
    expect(() => h.newTask({ title: 'x', owner: '*:engineer' })).toThrow(
      "owner *:engineer matches no waking agent of the role's providers " +
        '(opsd.roles.engineer.providers, overflow), so no run picks it up; ' +
        'use a configured agent (fake:engineer), or human:dawid (use --force to override)',
    );
    // A waking provider of another role still gets its group suggested.
    roleFile(rootDir, 'fake-qa');
    const mixed = waking(['fake:engineer', 'fake:qa'], {
      engineer: { providers: ['other'] },
      qa: { providers: ['fake'] },
    });
    expect(as('human:dawid', { user: mixed }).ownerSuggestions()).toBe(
      'use a role group (*:qa), or a configured agent (fake:engineer, fake:qa), or human:dawid',
    );
    const first = waking(['fake:engineer'], {
      engineer: { providers: ['other', 'fake'], overflow: false },
    });
    expect(as('human:dawid', { user: first }).ownerRefusal('*:engineer')).toMatch(/providers/);
    const overflow = waking(['fake:engineer'], { engineer: { providers: ['other', 'fake'] } });
    expect(as('human:dawid', { user: overflow }).ownerRefusal('*:engineer')).toBeNull();
  });

  it('checks a role group against configured agents when no agent wakes', () => {
    const { as, rootDir } = setup();
    roleFile(rootDir, 'claude-engineer');
    const h = as('human:dawid');
    expect(h.ownerRefusal('*:engineer')).toBeNull();
    expect(h.ownerRefusal('*:qa')).toBe('*:qa matches no configured agent');
    // With no agent waking, configured agents stand in for the groups, as in ownerRefusal.
    expect(h.ownerSuggestions()).toBe(
      'use a role group (*:engineer), or a configured agent (claude:engineer), or human:dawid',
    );
  });

  it('checks nothing in a store without agent definitions', () => {
    const { as } = setup();
    expect(as('human:dawid').ownerRefusal('*:release')).toBeNull();
    expect(as('human:dawid').newTask({ title: 'x', owner: 'claude:release' }).owner).toBe(
      'claude:release',
    );
  });
});
