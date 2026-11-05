import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { ActivityItem } from '@agent-ops/core';
import {
  messagesSince,
  OpsError,
  ownerMatches,
  secretKind,
  ulid,
  ulidTimePrefix,
} from '@agent-ops/core';
import type { RunRecord } from './runs.js';
import type { ChatPromptMessage } from './runtimes.js';
import { chatPrompt } from './runtimes.js';
import type { Supervisor } from './supervisor.js';

/** One line of the chat: a message to the agent, its reply, or a note from opsd. */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  at: string;
  text: string;
  /** User messages: who wrote it, the person in the app or a channel author. */
  from?: string;
  /** User messages from a channel post that mentions the agent: the channel, without `#`. */
  channel?: string;
  root?: string;
  /**
   * User messages: `queued` until a turn reads them, then `sent`; `cancelled` by the stop
   * button before any turn read them.
   */
  status?: 'queued' | 'sent' | 'cancelled';
  /** The run that read the message or wrote the reply. */
  run?: string;
  /** Replies: what the turn changed in Agent Ops, in the order it happened. */
  actions?: ChatAction[];
  /** Replies: why the turn ended without finishing, such as a stop or a crash. */
  error?: string;
}

/** Something a chat turn did through `ops`: a task event, a new task or a channel post. */
export interface ChatAction {
  kind: 'task' | 'channel';
  /** The event type, `created` for a new task, or `post`. */
  type: string;
  root: string;
  task?: string;
  title?: string;
  channel?: string;
  summary: string;
}

/** What `chat.json` in the state folder holds. Local to this machine; never committed. */
interface ChatState {
  /** The Claude session the next turn resumes, and the folder it lives in. */
  session?: string;
  cwd?: string;
  /** The live turn's run. */
  run?: string;
  messages: ChatMessage[];
  /** Per root, the newest channel message already read for mentions. */
  markers: Record<string, string>;
}

/** The chat as the API returns it. */
export interface ChatView {
  agent: string;
  mentions: boolean;
  messages: ChatMessage[];
  /** The live turn. */
  live: RunRecord | null;
  /** The reply of the live turn so far. */
  streaming: string | null;
  /** Another run of the agent (an inbox wake) that queued messages wait for. */
  busy: RunRecord | null;
  /** Why queued messages have not started, or null. */
  waiting: string | null;
}

const FILE = 'chat.json';
/** Messages kept in `chat.json`; older ones drop off. */
const KEEP = 500;
/** Longest message the chat takes, in characters. */
const MAX_TEXT = 20_000;
/** How often a live turn's log is read for the reply, in ms. */
const STREAM_MS = 300;
/** How far back mentions count the first time opsd looks. */
const FIRST_LOOK_MS = 24 * 3_600_000;
/** Task events that are bookkeeping, not something the agent decided to do. */
const NOT_ACTIONS = new Set(['run-start', 'run-end', 'renew', 'claim', 'release', 'start']);

/**
 * Reads a Claude `stream-json` log as it grows and keeps the reply text: the text of each
 * assistant message of the main agent, joined by blank lines. With `--include-partial-messages`
 * the text grows word by word; without it, a whole message at a time.
 */
export class ReplyReader {
  private buffer = '';
  private readonly parts: string[] = [];
  private partial = false;
  private open = false;
  /** The error a failed turn reported. */
  error: string | null = null;

  get text(): string {
    return this.parts
      .map((p) => p.trim())
      .filter(Boolean)
      .join('\n\n');
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) this.line(line.trim());
  }

  end(): void {
    const rest = this.buffer;
    this.buffer = '';
    this.line(rest.trim());
  }

  private line(line: string): void {
    if (!line.startsWith('{')) return;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    // Sub-agents' messages carry the tool call that started them; the chat shows the main agent.
    if (ev.parent_tool_use_id) return;
    if (ev.type === 'stream_event') {
      const e = ev.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
      if (e?.type === 'message_start') {
        this.parts.push('');
        this.open = true;
      } else if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
        this.partial = true;
        if (!this.open) {
          this.parts.push('');
          this.open = true;
        }
        this.parts[this.parts.length - 1] += e.delta.text ?? '';
      }
    } else if (ev.type === 'assistant' && !this.partial) {
      const content = (ev.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) return;
      const text = content
        .filter((b): b is { type: 'text'; text: string } => {
          const x = b as { type?: unknown; text?: unknown };
          return x.type === 'text' && typeof x.text === 'string';
        })
        .map((b) => b.text)
        .join('');
      if (text) this.parts.push(text);
    } else if (ev.type === 'result' && ev.is_error) {
      this.error = typeof ev.result === 'string' && ev.result ? ev.result : 'the turn failed';
    }
  }
}

/** A live turn: its run and how far its log was read. */
interface Turn {
  run: string;
  log: string;
  offset: number;
  decoder: StringDecoder;
  reader: ReplyReader;
  timer?: NodeJS.Timeout;
  last: string;
}

/**
 * The desktop chat with the PM. Each turn is one run of the chat agent under the usual
 * limits; the turns share one Claude session, so the context carries from message to message.
 * Channel posts that mention the agent join the chat as messages.
 */
export class Chat {
  private turn?: Turn;
  private waitReason: string | null = null;

  constructor(
    private readonly host: Supervisor,
    private readonly now: () => number,
  ) {
    host.on('run', (r: RunRecord) => {
      if (r.status === 'ended' && r.id === this.turn?.run) this.finish(r);
    });
  }

  get agent(): string {
    return this.host.config.chat.agent;
  }

  private read(): ChatState {
    const s = this.host.store.readJson<Partial<ChatState>>(FILE, {});
    return { ...s, messages: s.messages ?? [], markers: s.markers ?? {} };
  }

  private write(s: ChatState): void {
    s.messages = s.messages.slice(-KEEP);
    this.host.store.writeJson(FILE, s);
  }

  view(): ChatView {
    const s = this.read();
    const live = this.liveRun(s);
    const busy = live ? null : (this.host.liveFor(this.agent) ?? null);
    const queued = s.messages.some((m) => m.status === 'queued');
    return {
      agent: this.agent,
      mentions: this.host.config.chat.mentions,
      messages: s.messages,
      live,
      streaming: live && this.turn?.run === live.id ? this.turn.reader.text : null,
      busy,
      waiting: queued && !live ? this.waitReason : null,
    };
  }

  /**
   * The live turn, by its run id: with `max_live` above 1 the agent can have other live runs,
   * such as an inbox wake, beside the turn.
   */
  private liveRun(s: ChatState): RunRecord | null {
    if (!s.run) return null;
    return this.host.liveRun(s.run) ?? null;
  }

  /** Adds a message from the person in the app and starts a turn when the limits have room. */
  send(text: string, actor?: string): ChatView {
    const from = this.host.ws(actor).actor;
    if (!from) throw new OpsError("set 'as', or `me` in the user config", 2);
    const body = text.trim();
    if (!body) throw new OpsError('the message is empty', 2);
    if (body.length > MAX_TEXT) {
      throw new OpsError(`the message is longer than ${MAX_TEXT} characters`, 2);
    }
    const kind = secretKind(body);
    if (kind) throw new OpsError(`refusing to send: the text looks like a ${kind}`, 2);
    const s = this.read();
    s.messages.push({
      id: ulid(this.now()),
      role: 'user',
      at: new Date(this.now()).toISOString(),
      text: body,
      from,
      status: 'queued',
    });
    this.write(s);
    this.pump();
    return this.view();
  }

  /**
   * Stops the live turn and drops the messages no turn read yet. Without a live turn, it stops
   * the agent's other run that queued messages wait for.
   */
  stop(): ChatView {
    const s = this.read();
    const live = this.liveRun(s);
    if (live) {
      this.cancelQueued(s);
      this.host.kill(live.id, 'stopped');
      return this.view();
    }
    const busy = this.host.liveFor(this.agent);
    if (busy) this.host.kill(busy.id, 'stopped');
    else this.cancelQueued(s);
    return this.view();
  }

  private cancelQueued(s: ChatState): void {
    let changed = false;
    for (const m of s.messages) {
      if (m.status !== 'queued') continue;
      m.status = 'cancelled';
      changed = true;
    }
    if (changed) this.write(s);
    this.waitReason = null;
  }

  /**
   * Starts a new conversation: a new session, no messages. The old one is kept in the state
   * folder as `chat-<id>.json`.
   */
  reset(): ChatView {
    const s = this.read();
    if (this.liveRun(s)) throw new OpsError('a reply is still running: stop it first');
    if (s.messages.length > 0 || s.session)
      this.host.store.writeJson(`chat-${ulid(this.now())}.json`, s);
    this.waitReason = null;
    this.write({ messages: [], markers: s.markers });
    this.emitChange();
    return this.view();
  }

  /** Each tick: reads new mentions, then starts a turn for queued messages if there is room. */
  tick(): void {
    if (this.host.config.chat.mentions) this.readMentions();
    this.pump();
  }

  /** After a restart: watches a turn the next opsd adopted, or records one that ended meanwhile. */
  resume(): void {
    const s = this.read();
    if (!s.run || this.turn) return;
    let r: RunRecord | undefined;
    try {
      r = this.host.run(s.run);
    } catch {
      r = undefined;
    }
    if (!r) {
      delete s.run;
      this.write(s);
      return;
    }
    this.watch(r);
    if (r.status === 'ended') this.finish(r);
  }

  /** Stops reading a live turn's log; the next opsd picks the turn up again. */
  close(): void {
    if (this.turn?.timer) clearInterval(this.turn.timer);
    this.turn = undefined;
  }

  private readMentions(): void {
    const ws = this.host.ws();
    const s = this.read();
    const first = ulidTimePrefix(this.now() - FIRST_LOOK_MS);
    let changed = false;
    for (const root of ws.roots) {
      const marker = s.markers[root.name] ?? first;
      let newest = marker;
      for (const m of messagesSince(root, marker)) {
        if (m.id > newest) newest = m.id;
        if (m.actor === this.agent) continue;
        if (!(m.mentions ?? []).some((who) => ownerMatches(who, this.agent))) continue;
        s.messages.push({
          id: ulid(this.now()),
          role: 'user',
          at: m.at,
          text: m.body,
          from: m.actor,
          channel: m.channel,
          root: root.name,
          status: 'queued',
        });
      }
      if (newest !== (s.markers[root.name] ?? '')) {
        s.markers[root.name] = newest;
        changed = true;
      }
    }
    if (changed) {
      this.write(s);
      this.emitChange();
    }
  }

  /** Starts a turn for every queued message, when no turn is live and the limits have room. */
  private pump(): void {
    const s = this.read();
    if (this.liveRun(s)) return;
    const queued = s.messages.filter((m) => m.status === 'queued');
    if (queued.length === 0) {
      this.waitReason = null;
      return;
    }
    const ws = this.host.ws(this.agent);
    const cwd = this.host.checkoutOf(ws, this.agent);
    const why = this.host.blocker(this.agent, this.host.projectOf(ws), { cwd });
    if (why) {
      if (why !== this.waitReason) {
        this.waitReason = why;
        this.emitChange();
      }
      return;
    }
    this.waitReason = null;
    const resume = s.session !== undefined && s.cwd === cwd;
    const session = resume ? s.session! : randomUUID();
    const def = ws.agent(this.agent);
    const messages: ChatPromptMessage[] = queued.map((m) => ({
      from: m.from ?? 'someone',
      text: m.text,
      channel: m.channel,
    }));
    const prompt = chatPrompt({
      agent: this.agent,
      human: this.host.userConfig.me ?? 'the human',
      first: !resume,
      roleFile: def?.file,
      role: def,
      messages,
    });
    let r: RunRecord;
    try {
      r = this.host.launch({
        agent: this.agent,
        prompt,
        budget: this.host.config.chat.budget,
        chat: { session, resume },
      });
    } catch (err) {
      this.waitReason = err instanceof Error ? err.message : String(err);
      this.emitChange();
      return;
    }
    for (const m of queued) {
      m.status = 'sent';
      m.run = r.id;
    }
    s.run = r.id;
    s.session = session;
    s.cwd = cwd;
    this.write(s);
    this.watch(r);
    this.emitChange();
  }

  private watch(r: RunRecord): void {
    this.close();
    const turn: Turn = {
      run: r.id,
      log: r.log,
      offset: 0,
      decoder: new StringDecoder('utf8'),
      reader: new ReplyReader(),
      last: '',
    };
    this.turn = turn;
    if (r.status === 'running') {
      turn.timer = setInterval(() => this.readTurn(turn), STREAM_MS);
      turn.timer.unref?.();
    }
  }

  /** Reads what the turn wrote since the last look and sends the reply so far to listeners. */
  private readTurn(turn: Turn): void {
    let size: number;
    try {
      size = statSync(turn.log).size;
    } catch {
      return;
    }
    if (size > turn.offset) {
      const fd = openSync(turn.log, 'r');
      try {
        const buf = Buffer.alloc(Math.min(size - turn.offset, 1024 * 1024));
        while (turn.offset < size) {
          const n = readSync(fd, buf, 0, Math.min(buf.length, size - turn.offset), turn.offset);
          if (n <= 0) break;
          turn.offset += n;
          turn.reader.feed(turn.decoder.write(buf.subarray(0, n)));
        }
      } finally {
        closeSync(fd);
      }
    }
    const text = turn.reader.text;
    if (text !== turn.last) {
      turn.last = text;
      this.host.emit('chat', { run: turn.run, streaming: text });
    }
  }

  /** Records the reply of an ended turn, then starts the next turn for messages that came meanwhile. */
  private finish(r: RunRecord): void {
    const turn = this.turn;
    if (!turn || turn.run !== r.id) return;
    this.readTurn(turn);
    turn.reader.end();
    this.close();
    const s = this.read();
    if (s.run !== r.id) return;
    delete s.run;
    const text = turn.reader.text;
    let error: string | undefined;
    if (r.reason === 'stopped') error = 'stopped';
    else if (r.reason && r.reason !== 'exit') error = `ended: ${r.reason}`;
    else if (r.exit !== 0) error = turn.reader.error ?? `exit ${r.exit ?? '-'}`;
    else if (turn.reader.error) error = turn.reader.error;
    // A turn that failed without a word may not have a session to resume: start a new one.
    if (error && error !== 'stopped' && !text) {
      delete s.session;
      error += '; the next message starts a new session';
    }
    s.messages.push({
      id: ulid(this.now()),
      role: 'assistant',
      at: new Date(this.now()).toISOString(),
      text,
      run: r.id,
      actions: this.actions(r),
      error,
    });
    this.write(s);
    this.emitChange();
    this.pump();
  }

  /**
   * What the agent did in Agent Ops while the turn ran. Events do not name the run that wrote
   * them, so with `max_live` above 1 the actions of another run of the agent in the same window
   * show up here too.
   */
  private actions(r: RunRecord): ChatAction[] | undefined {
    let items: ActivityItem[];
    try {
      items = this.host.ws().activity({ limit: 1000 });
    } catch {
      return undefined;
    }
    const from = r.started_at;
    const to = r.ended_at ?? new Date(this.now()).toISOString();
    const out = items
      .filter((i) => i.actor === r.agent && i.at >= from && i.at <= to && !NOT_ACTIONS.has(i.type))
      .reverse()
      .slice(0, 50)
      .map((i) => ({
        kind: i.kind,
        type: i.type,
        root: i.root,
        task: i.task,
        title: i.title,
        channel: i.channel,
        summary: i.body.split('\n')[0] ?? '',
      }));
    return out.length > 0 ? out : undefined;
  }

  private emitChange(): void {
    this.host.emit('chat', { changed: true });
  }
}
