/**
 * Counts tokens from a run's log as it grows. It reads Claude's `stream-json` and Codex's `--json`
 * output. Counted: input, cache writes and output; cache reads are left out, because every turn
 * re-reads the whole context from the cache and they cost a fraction of fresh input.
 */
export class UsageMeter {
  private buffer = '';
  private readonly claudeMessages = new Map<string, number>();
  private claudeResult: number | null = null;
  private codexTurns = 0;
  private codexText: number | null = null;
  private expectCodexTotal = false;
  /** The last Claude `rate_limit_event` info, and how many were seen. */
  rateLimit: unknown = null;
  rateLimitSeen = 0;
  /** Codex's thread id from `thread.started`: names its session file. */
  threadId: string | null = null;
  /**
   * The run hit its provider's usage limit, from an error in its output; `resetsAt` (ms) when the
   * message names it. A fallback for runs whose output has no rate limit event.
   */
  limitHit: { resetsAt?: number } | null = null;
  limitHits = 0;
  /** The runtime could not sign in, such as an expired OAuth session (AO-0150). */
  authFailed = false;

  get tokens(): number {
    if (this.claudeResult !== null) return this.claudeResult;
    let claude = 0;
    for (const n of this.claudeMessages.values()) claude += n;
    if (claude > 0) return claude;
    return Math.max(this.codexTurns, this.codexText ?? 0);
  }

  /** Counts a last line that has no newline yet; call when the run has ended. */
  end(): void {
    const rest = this.buffer;
    this.buffer = '';
    this.line(rest.trim());
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) this.line(line.trim());
  }

  private line(line: string): void {
    if (!line) return;
    if (this.expectCodexTotal) {
      this.expectCodexTotal = false;
      const n = Number(line.replace(/[,\s]/g, ''));
      if (Number.isFinite(n)) this.codexText = n;
    }
    if (line === 'tokens used') {
      this.expectCodexTotal = true;
      return;
    }
    if (line[0] !== '{') {
      // Plain text counts only as the runtime's own error line, never as an agent's prose.
      if (ERROR_LINE_RE.test(line)) this.checkError(line);
      return;
    }
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (ev.type === 'assistant') {
      const msg = ev.message as { id?: string; usage?: Usage } | undefined;
      if (msg?.usage)
        this.claudeMessages.set(msg.id ?? String(this.claudeMessages.size), count(msg.usage));
      // Claude Code marks its own API error message; an agent's prose never sets this field.
      if (ev.error === 'authentication_failed') this.authFailed = true;
    } else if (ev.type === 'result') {
      if (ev.usage) this.claudeResult = count(ev.usage as Usage);
      if (ev.is_error) this.checkError(String(ev.result ?? ''));
    } else if (ev.type === 'error' || ev.type === 'turn.failed') {
      const err = ev.error as { type?: string; message?: string } | undefined;
      // The API's own error type, whatever the message says.
      if (err?.type === 'rate_limit_error') this.checkLimit('rate_limit_error');
      else if (err?.type === 'authentication_error') this.authFailed = true;
      else this.checkError(String(ev.message ?? err?.message ?? ''));
    } else if (ev.type === 'rate_limit_event') {
      this.rateLimit = ev.rate_limit_info ?? null;
      this.rateLimitSeen++;
    } else if (ev.type === 'thread.started' && typeof ev.thread_id === 'string') {
      this.threadId = ev.thread_id;
    } else if (ev.type === 'turn.completed' && ev.usage) {
      const u = ev.usage as Usage;
      this.codexTurns +=
        (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0) + (u.output_tokens ?? 0);
    }
  }

  /** Notes a runtime error that is a usage limit or a failed sign-in. */
  private checkError(text: string): void {
    this.checkLimit(text);
    if (text && AUTH_RE.test(text)) this.authFailed = true;
  }

  /** Notes a usage-limit error; Claude Code's older format ends in `|<reset epoch seconds>`. */
  private checkLimit(text: string): void {
    if (!text || !LIMIT_RE.test(text)) return;
    const epoch = /\|(\d{10})\b/.exec(text);
    this.limitHit = epoch ? { resetsAt: Number(epoch[1]) * 1000 } : {};
    this.limitHits++;
  }
}

/** A runtime's own error line: `Error: ...`, `API Error: 429 ...`. */
const ERROR_LINE_RE = /^(api )?error\b/i;

/** What providers print when a plan's usage limit or an API rate limit stops work. */
const LIMIT_RE =
  /usage limit (reached|hit|has been reached)|hit your usage limit|rate_limit_error|exceeded your (current )?quota/i;

/** What runtimes print when they cannot sign in: an expired session, no login, a bad API key. */
const AUTH_RE =
  /authentication_failed|authentication_error|failed to authenticate|oauth (session|token) (has )?expired|not logged in|please run \/login|invalid api key|401 unauthorized/i;

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cached_input_tokens?: number;
}

function count(u: Usage): number {
  return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
}
