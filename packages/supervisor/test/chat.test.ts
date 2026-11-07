import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initRoot, Workspace } from '@agent-ops/core';
import type { RunRecord } from '../src/index.js';
import {
  CHAT_DENY,
  CHAT_TOOLS,
  chatPrompt,
  invocation,
  opsdConfig,
  ReplyReader,
  Supervisor,
} from '../src/index.js';
import { killOwn } from './own-procs.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoTop = join(here, '..', '..', '..');
const coreDist = join(repoTop, 'packages', 'core', 'dist', 'index.js');
const dirs: string[] = [];
const sups: Supervisor[] = [];
/** Files the fake agents append their PIDs to. */
const pidFiles: string[] = [];

beforeAll(() => {
  // The fake agent is a separate process, so it needs the built core.
  execFileSync(
    process.execPath,
    [join(repoTop, 'node_modules', 'typescript', 'bin', 'tsc'), '-b', 'packages/core'],
    { cwd: repoTop, windowsHide: true },
  );
});

afterEach(async () => {
  for (const s of sups.splice(0)) {
    s.stop({ killRuns: true });
    await s.close();
  }
  // A fake agent that outlives its run holds the temp folders open on Windows: where opsd cannot
  // list processes, as in a sandbox, it stops only the hidden shell, not the launcher and the
  // fake. Each fake wrote its PIDs and the time it ran; wait for them to exit, then stop the ones
  // that still run the fake's processes. Most have exited long ago, and Windows may have given
  // their PIDs to other processes, such as a vitest worker, which a bare kill would end (AO-0145).
  const pids = pidFiles.splice(0).flatMap((f) =>
    readFileSync(f, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [pid, at] = line.split(' ').map(Number);
        return { pid: pid!, at: at! };
      }),
  );
  const left: typeof pids = [];
  for (const p of pids) if (!(await gone(p.pid, 2_000))) left.push(p);
  const killed: number[] = [];
  for (const p of left) if (await killOwn(p.pid, p.at)) killed.push(p.pid);
  for (const pid of killed) {
    if (!(await gone(pid, 5_000))) throw new Error(`fake agent ${pid} did not exit`);
  }
  for (const d of dirs.splice(0)) await remove(d);
  // close() alone may wait 10 s for runs it could not stop.
}, 60_000);

/**
 * Windows keeps a folder locked for a moment after the processes in it exit, and rmSync's own
 * retries give up on that EPERM, so this retries for up to 15 s.
 */
async function remove(d: string): Promise<void> {
  const end = Date.now() + 15_000;
  for (;;) {
    try {
      rmSync(d, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(code ?? '') || Date.now() > end) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the PID exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function gone(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'opsd-chat-'));
  dirs.push(d);
  return d;
}

/**
 * A fake chat agent: writes its prompt to FAKE_PROMPTS, streams a reply word by word in Claude's
 * `stream-json`, and creates a task when the message asks for one.
 */
const FAKE_CHAT = `
const fs = await import('node:fs');
// Windows: the parent is opsd's launcher, which outlives opsd by design. Unix: the test itself.
// Each with a time both ran, so cleanup can tell them from later processes that reuse the PIDs.
const pids = process.platform === 'win32' ? [process.pid, process.ppid] : [process.pid];
const at = Date.now();
fs.appendFileSync(process.env.FAKE_PIDS, pids.map((p) => p + ' ' + at).join('\\n') + '\\n');
const { Workspace } = await import(${JSON.stringify(pathToFileURL(coreDist).href)});
let prompt = '';
for await (const c of process.stdin) prompt += c;
fs.appendFileSync(process.env.FAKE_PROMPTS, JSON.stringify(prompt) + '\\n');
const modeFile = process.env.FAKE_MODE_FILE;
const mode = (modeFile && fs.existsSync(modeFile) ? fs.readFileSync(modeFile, 'utf8').trim() : process.env.FAKE_MODE) ?? 'reply';
const out = (o) => console.log(JSON.stringify(o));
const delta = (text) => out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
out({ type: 'system', subtype: 'init', session_id: 'x' });
if (mode === 'auth') {
  // What Claude Code prints when its OAuth session expired (AO-0150).
  const text = 'Failed to authenticate: OAuth session expired and could not be refreshed';
  out({ type: 'assistant', message: { id: 'm0', model: '<synthetic>', content: [{ type: 'text', text }] }, error: 'authentication_failed', is_api_error_message: true });
  out({ type: 'result', is_error: true, result: text });
  process.exit(1);
}
out({ type: 'stream_event', event: { type: 'message_start' } });
if (mode === 'fail') {
  out({ type: 'result', is_error: true, result: 'No conversation found' });
  process.exit(1);
}
delta('Thinking');
if (mode === 'hang') setInterval(() => {}, 1000);
else {
  if (prompt.includes('new task')) {
    new Workspace({ cwd: process.cwd(), env: process.env }).newTask({ title: 'from the chat' });
  }
  delta(' done.');
  out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Thinking done.' }], usage: { input_tokens: 10, output_tokens: 5 } } });
  out({ type: 'result', result: 'Thinking done.', usage: { input_tokens: 10, output_tokens: 5 } });
}
`;

function setup(
  opts: { mode?: string; opsd?: Record<string, unknown>; env?: Record<string, string> } = {},
) {
  const repo = temp();
  execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  initRoot(repo, { name: 'test', human: 'human:dawid' });
  const agentFile = join(temp(), 'fake-chat.mjs');
  writeFileSync(agentFile, FAKE_CHAT);
  const prompts = join(temp(), 'prompts.jsonl');
  writeFileSync(prompts, '');
  const pids = join(temp(), 'pids.txt');
  writeFileSync(pids, '');
  pidFiles.push(pids);
  const env = {
    ...process.env,
    OPS_CONFIG: join(repo, 'none.yml'),
    OPS_STATE_DIR: temp(),
    FAKE_MODE: opts.mode ?? 'reply',
    FAKE_PROMPTS: prompts,
    FAKE_PIDS: pids,
    ...(opts.env ?? {}),
  } as NodeJS.ProcessEnv;
  delete env.OPS_AGENT;
  delete env.OPS_ROOTS;
  const config = opsdConfig({
    opsd: {
      sync: false,
      chat: { agent: 'claude:orchestrator', mentions: true },
      ...(opts.opsd ?? {}),
      // The chat runs on Claude only, so the fake agent stands in for the claude command; it
      // ignores the Claude flags that follow its script.
      runtimes: {
        claude: {
          command: process.execPath,
          args: [agentFile],
          // No sign-in check: `claude auth status` has no stand-in here.
          sign_in_check: false,
        },
      },
    },
  });
  const sup = new Supervisor({
    env,
    cwd: repo,
    user: { me: 'human:dawid' },
    config,
    freeMem: () => 64 * 2 ** 30,
  });
  sups.push(sup);
  const as = (actor: string) => new Workspace({ cwd: repo, env, actor, user: {} });
  const sent = (): string[] =>
    readFileSync(prompts, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string);
  return { sup, as, env, sent };
}

function ended(sup: Supervisor, id: string, ms = 15_000): Promise<RunRecord> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`run ${id} did not end`)), ms);
    const check = (r: RunRecord): void => {
      if (r.id !== id || r.status !== 'ended') return;
      clearTimeout(timer);
      sup.off('run', check);
      resolve(r);
    };
    sup.on('run', check);
  });
}

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('chat', () => {
  it('runs each message as a turn, streams the reply and lists what the turn changed', async () => {
    const { sup, sent, as } = setup();
    const streamed: string[] = [];
    sup.on('chat', (d: { streaming?: string }) => d.streaming && streamed.push(d.streaming));
    const v = sup.chat.send('Add a new task for the docs');
    expect(v.live).toMatchObject({ agent: 'claude:orchestrator', chat: true });
    expect(v.messages).toMatchObject([{ role: 'user', from: 'human:dawid', status: 'sent' }]);
    await ended(sup, v.live!.id);
    const after = sup.chat.view();
    expect(after.live).toBeNull();
    const reply = after.messages.at(-1)!;
    expect(reply).toMatchObject({ role: 'assistant', text: 'Thinking done.', run: v.live!.id });
    expect(reply.error).toBeUndefined();
    expect(reply.actions).toMatchObject([
      { kind: 'task', type: 'created', task: 'T-0001', title: 'from the chat' },
    ]);
    expect(as('human:dawid').view('1').meta.created_by).toBe('claude:orchestrator');
    expect(streamed.length).toBeGreaterThan(0);
    expect(sent()[0]).toContain('Chat rules');
    expect(sent()[0]).toContain('human:dawid writes:');
    // The chat runs in the data root's checkout: its turns get the store-checkout rule and deny
    // list too (AO-0135).
    expect(sent()[0]).toContain('holds the task store');
    expect(sup.run(v.live!.id).command).toContain('Bash(git checkout*)');

    // The next message continues the session: a short reminder instead of the full rules.
    const next = sup.chat.send('And one more thing');
    await ended(sup, next.live!.id);
    expect(sent()[1]).toContain('Next turn of the chat');
    expect(sent()[1]).not.toContain('Chat rules');
    expect(sup.chat.view().messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });

  it('counts under the role limit and waits for the agent run that holds it', async () => {
    const { sup, sent } = setup({ mode: 'hang' });
    // An inbox wake of the same agent: the orchestrator role has max_live 1 by default.
    const wake = sup.launch({ agent: 'claude:orchestrator' });
    await until(() => sent().length === 1);
    const v = sup.chat.send('hello');
    expect(v.live).toBeNull();
    expect(v.busy?.id).toBe(wake.id);
    expect(v.waiting).toMatch(/orchestrator runs live; max_live is 1/);
    expect(v.messages[0]).toMatchObject({ status: 'queued' });
    // Stop with no turn live stops the run the chat waits for; the message stays queued.
    const stopped = ended(sup, wake.id);
    sup.chat.stop();
    await stopped;
    expect(sup.chat.view().messages[0]).toMatchObject({ status: 'queued' });
    sup.chat.tick();
    const turn = sup.chat.view().live;
    expect(turn).not.toBeNull();
    // The wake run wrote the first prompt; the turn writes the second.
    await until(() => sent().length === 2);
    expect(sent()[1]).toContain('Chat rules');
    // The live turn holds the role in turn: another run of the agent is refused.
    expect(() => sup.launch({ agent: 'claude:orchestrator' })).toThrow(/max_live is 1/);
  });

  it('tracks the turn by its run when another run of the agent started first', async () => {
    const { sup, sent } = setup({
      mode: 'hang',
      opsd: { roles: { orchestrator: { max_live: 2 } } },
    });
    const wake = sup.launch({ agent: 'claude:orchestrator' });
    await until(() => sent().length === 1);
    const v = sup.chat.send('hello');
    const turn = v.live;
    expect(turn).not.toBeNull();
    expect(turn!.id).not.toBe(wake.id);
    expect(v.busy).toBeNull();
    await until(() => (sup.chat.view().streaming ?? '').includes('Thinking'));
    expect(sup.chat.view().live?.id).toBe(turn!.id);
    // A live turn blocks a new conversation even though the older wake run comes first.
    expect(() => sup.chat.reset()).toThrow(/still running/);
    // Stop ends the turn, not the wake run.
    const done = ended(sup, turn!.id);
    sup.chat.stop();
    await done;
    expect(sup.run(wake.id).status).toBe('running');
    expect(sup.chat.view().messages.at(-1)).toMatchObject({
      role: 'assistant',
      run: turn!.id,
      error: 'stopped',
    });
    const wakeEnded = ended(sup, wake.id);
    sup.kill(wake.id);
    await wakeEnded;
  });

  it('stops a live turn and drops messages no turn read yet', async () => {
    const { sup } = setup({ mode: 'hang' });
    const v = sup.chat.send('first');
    await until(() => (sup.chat.view().streaming ?? '').includes('Thinking'));
    sup.chat.send('second, while the first runs');
    expect(sup.chat.view().messages.at(-1)).toMatchObject({ status: 'queued' });
    const done = ended(sup, v.live!.id);
    sup.chat.stop();
    await done;
    const msgs = sup.chat.view().messages;
    expect(msgs.find((m) => m.text.startsWith('second'))).toMatchObject({ status: 'cancelled' });
    expect(msgs.at(-1)).toMatchObject({ role: 'assistant', text: 'Thinking', error: 'stopped' });
    expect(sup.chat.view().live).toBeNull();
  });

  it('starts a new session after a turn that failed without a reply', async () => {
    const { sup, sent } = setup({ mode: 'fail' });
    const v = sup.chat.send('hi');
    await ended(sup, v.live!.id);
    expect(sup.chat.view().messages.at(-1)!.error).toMatch(
      /No conversation found; the next message starts a new session/,
    );
    const next = sup.chat.send('again');
    await ended(sup, next.live!.id);
    expect(sent()[1]).toContain('Chat rules');
  });

  it('starts a turn while the runtime backs off after failed starts (AO-0150)', async () => {
    const { sup } = setup({ mode: 'fail' });
    // A run that ends with an error at once puts the runtime in backoff for other runs.
    const r = sup.launch({ agent: 'claude:orchestrator' });
    await ended(sup, r.id);
    expect(sup.blocker('claude:orchestrator', 'test')).toMatch(/within 10 s 1 time\(s\) in a row/);
    // The human's chat message is a try of its own: it starts a turn instead of waiting.
    const v = sup.chat.send('hi');
    expect(v.waiting).toBeFalsy();
    expect(v.live).toMatchObject({ agent: 'claude:orchestrator', chat: true });
    await ended(sup, v.live!.id);
  });

  it('answers that Claude is signed out and sends the messages once it is signed in (AO-0154)', async () => {
    const modeFile = join(temp(), 'mode');
    writeFileSync(modeFile, 'auth');
    const { sup, sent } = setup({ env: { FAKE_MODE_FILE: modeFile } });
    const v = sup.chat.send('hi');
    await ended(sup, v.live!.id);
    expect(sup.signedOut('claude')).toMatchObject({ run: v.live!.id });
    let view = sup.chat.view();
    // The message waits instead of failing, and the reply says how to sign in.
    expect(view.messages).toMatchObject([
      { role: 'user', text: 'hi', status: 'queued' },
      { role: 'assistant' },
    ]);
    expect(view.messages[1]!.text).toMatch(
      /^Claude is signed out on this PC, so claude:orchestrator cannot answer yet\. To sign in, run `claude`, then `\/login`\./,
    );
    expect(view.messages[1]!.error).toBeUndefined();
    // More messages wait too, with no second reply and no run.
    sup.chat.send('second');
    sup.chat.tick();
    view = sup.chat.view();
    expect(view.waiting).toMatch(/claude is signed out/);
    expect(view.live).toBeNull();
    expect(view.messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(sent()).toHaveLength(1);
    // Signed in again: one turn reads both messages.
    writeFileSync(modeFile, 'reply');
    sup.resumeSignIn('claude');
    sup.chat.tick();
    const turn = sup.chat.view().live!;
    expect(turn).toMatchObject({ chat: true });
    await ended(sup, turn.id);
    view = sup.chat.view();
    expect(view.messages.filter((m) => m.role === 'user').map((m) => m.status)).toEqual([
      'sent',
      'sent',
    ]);
    expect(view.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Thinking done.' });
    expect(sent()[1]).toContain('hi');
    expect(sent()[1]).toContain('second');
  });

  it('continues the chat from channel mentions and keeps them out of inbox wakes', async () => {
    const { sup, as, sent } = setup({
      opsd: { agents: { 'claude:orchestrator': { wake: true } } },
    });
    as('human:dawid').post('general', 'Hey @*:orchestrator, what is open for v2?');
    as('claude:engineer').post('general', 'no mention here');
    expect(sup.waits().filter((w) => w.kind === 'inbox')).toEqual([]);
    sup.chat.tick();
    const v = sup.chat.view();
    expect(v.messages).toMatchObject([
      { role: 'user', from: 'human:dawid', channel: 'general', status: 'sent' },
    ]);
    await ended(sup, v.live!.id);
    expect(sent()[0]).toContain('human:dawid mentioned you in #general');
    expect(sent()[0]).toContain('ops channel post general');
    // A mention is read once.
    sup.chat.tick();
    expect(sup.chat.view().messages).toHaveLength(2);
  });

  it('records a turn that ended while nothing watched it, as after a restart', async () => {
    const { sup } = setup();
    const v = sup.chat.send('hi');
    // As if opsd stopped right after the launch: nothing reads the turn's log.
    sup.chat.close();
    await ended(sup, v.live!.id);
    expect(sup.chat.view().messages.map((m) => m.role)).toEqual(['user']);
    sup.chat.resume();
    expect(sup.chat.view().messages.at(-1)).toMatchObject({
      role: 'assistant',
      text: 'Thinking done.',
      run: v.live!.id,
    });
  });

  it('starts a new conversation and keeps the old one', async () => {
    const { sup, sent } = setup();
    const v = sup.chat.send('hi');
    await ended(sup, v.live!.id);
    sup.chat.reset();
    expect(sup.chat.view().messages).toEqual([]);
    const next = sup.chat.send('fresh start');
    await ended(sup, next.live!.id);
    expect(sent()[1]).toContain('Chat rules');
  });

  it('refuses empty messages and text that looks like a secret', () => {
    const { sup } = setup();
    expect(() => sup.chat.send('   ')).toThrow(/empty/);
    expect(() => sup.chat.send(`key ghp_${'a'.repeat(36)}`)).toThrow(/refusing to send/);
    expect(sup.chat.view().messages).toEqual([]);
  });
});

describe('chat runtime', () => {
  it('starts a Claude session, then resumes it, with read-only tools and no verdicts', () => {
    const rc = { command: 'claude' };
    const first = invocation(rc, 'claude:orchestrator', undefined, '/w', [], [], {
      session: 'abc',
      resume: false,
    }).args;
    expect(first).toEqual(
      expect.arrayContaining(['--session-id', 'abc', '--include-partial-messages']),
    );
    expect(first[first.indexOf('--allowedTools') + 1]).toBe(
      [...CHAT_TOOLS, 'Bash(ops *)'].join(','),
    );
    for (const d of CHAT_DENY) expect(first[first.indexOf('--disallowedTools') + 1]).toContain(d);
    const next = invocation(rc, 'claude:orchestrator', undefined, '/w', [], [], {
      session: 'abc',
      resume: true,
    }).args;
    expect(next).toEqual(expect.arrayContaining(['--resume', 'abc']));
    expect(next).not.toContain('--session-id');
    // Other runs keep their arguments.
    const plain = invocation(rc, 'claude:engineer', undefined, '/w', []).args;
    expect(plain).not.toContain('--include-partial-messages');
    expect(plain[plain.indexOf('--disallowedTools') + 1]).not.toContain('ops verdict');
  });

  it('refuses a chat agent on another runtime than Claude, or a wildcard', () => {
    for (const agent of ['codex:orchestrator', 'cursor:orchestrator']) {
      expect(() => opsdConfig({ opsd: { chat: { agent } } } as never)).toThrow(
        /chat runs on Claude/,
      );
    }
    expect(() => opsdConfig({ opsd: { chat: { agent: '*:orchestrator' } } } as never)).toThrow(
      /opsd.chat.agent/,
    );
    expect(opsdConfig({}).chat).toEqual({
      agent: 'claude:pm',
      mentions: true,
      budget: undefined,
    });
  });

  it('writes a channel message as a request to answer there', () => {
    const p = chatPrompt({
      agent: 'claude:orchestrator',
      human: 'human:dawid',
      first: true,
      messages: [{ from: 'human:dawid', text: 'status?', channel: 'general' }],
    });
    expect(p).toContain('Never give a verdict');
    expect(p).toContain('`ops channel post general "..."`');
  });
});

describe('ReplyReader', () => {
  it('joins the main agent messages, word by word or whole, and skips sub-agents', () => {
    const r = new ReplyReader();
    const line = (o: unknown): string => `${JSON.stringify(o)}\n`;
    r.feed(line({ type: 'stream_event', event: { type: 'message_start' } }));
    r.feed(
      line({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
      }),
    );
    r.feed('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text');
    r.feed('_delta","text":"lo."}}}\n');
    r.feed(
      line({
        type: 'stream_event',
        parent_tool_use_id: 'tool1',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'sub' } },
      }),
    );
    // With partial messages on, whole messages repeat the text and are not added again.
    r.feed(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello.' }] } }));
    r.feed(line({ type: 'stream_event', event: { type: 'message_start' } }));
    r.feed(
      line({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done.' } },
      }),
    );
    expect(r.text).toBe('Hello.\n\nDone.');

    const whole = new ReplyReader();
    whole.feed(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'A' }] } }));
    whole.feed(line({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } }));
    whole.feed(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'B' }] } }));
    whole.end();
    expect(whole.text).toBe('A\n\nB');
  });
});
