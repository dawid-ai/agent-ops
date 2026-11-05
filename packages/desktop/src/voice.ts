// Voice to text for the composers. Kept apart from main.ts so it can be tested without Electron.
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Where speech becomes text. `off` (the default) records nothing. `local` runs whisper.cpp on this
 * PC, so audio never leaves it. `cloud` sends the recording to OpenAI's transcription API with the
 * key in `OPENAI_API_KEY`; the app never stores that key.
 */
export type VoiceEngine = 'off' | 'local' | 'cloud';
export const VOICE_ENGINES: VoiceEngine[] = ['off', 'local', 'cloud'];

/** The voice settings in the user config, under `desktop.voice`. */
export interface VoiceSettings {
  engine: VoiceEngine;
  /** whisper.cpp's command-line program (`whisper-cli.exe`), for `local`. */
  program: string | null;
  /** A whisper.cpp model file (`ggml-base.bin`), for `local`. */
  model: string | null;
  /** `auto` or a language code such as `en` or `pl`. */
  language: string;
  /** The OpenAI transcription model, for `cloud`. */
  cloudModel: string;
}

export const DEFAULT_CLOUD_MODEL = 'gpt-4o-mini-transcribe';
export const CLOUD_URL = 'https://api.openai.com/v1/audio/transcriptions';
export const CLOUD_KEY_ENV = 'OPENAI_API_KEY';

/** Five minutes of 16 kHz, 16-bit mono audio plus the header: longer recordings are refused. */
export const MAX_SECONDS = 300;
export const MAX_WAV_BYTES = 44 + MAX_SECONDS * 16_000 * 2;

const LANGUAGE = /^(auto|[a-z]{2,3})$/;

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function voiceSettings(user: unknown): VoiceSettings {
  const v = (user as { desktop?: { voice?: Record<string, unknown> } } | null)?.desktop?.voice;
  const engine = VOICE_ENGINES.includes(v?.engine as VoiceEngine)
    ? (v!.engine as VoiceEngine)
    : 'off';
  const language = text(v?.language)?.toLowerCase();
  return {
    engine,
    program: text(v?.program),
    model: text(v?.model),
    language: language && LANGUAGE.test(language) ? language : 'auto',
    cloudModel: text(v?.cloud_model) ?? DEFAULT_CLOUD_MODEL,
  };
}

/** A change from the Settings page: only the engine and the language. Throws on bad input. */
export function checkVoicePatch(patch: unknown): { engine?: VoiceEngine; language?: string } {
  const p = (patch ?? {}) as { engine?: unknown; language?: unknown };
  const out: { engine?: VoiceEngine; language?: string } = {};
  if (p.engine !== undefined) {
    if (!VOICE_ENGINES.includes(p.engine as VoiceEngine)) {
      throw new Error('voice engine: use off, local or cloud');
    }
    out.engine = p.engine as VoiceEngine;
  }
  if (p.language !== undefined) {
    const l = typeof p.language === 'string' ? p.language.trim().toLowerCase() : '';
    if (!LANGUAGE.test(l)) throw new Error('voice language: use auto or a code such as en or pl');
    out.language = l;
  }
  return out;
}

/** The YAML document methods `writeVoice` uses, so it needs no YAML import. */
interface ConfigDoc {
  getIn(path: unknown[]): unknown;
  setIn(path: unknown[], value: unknown): void;
  deleteIn(path: unknown[]): boolean;
}

export interface VoiceChange {
  engine?: VoiceEngine;
  language?: string;
  program?: string | null;
  model?: string | null;
}

/**
 * Writes a change under `desktop.voice` in the user config document. Defaults (`off`, `auto`)
 * and nulls remove their key, and an emptied `voice` or `desktop` map goes too.
 */
export function writeVoice(doc: ConfigDoc, change: VoiceChange): void {
  const defaults: Record<string, unknown> = { engine: 'off', language: 'auto' };
  for (const [k, v] of Object.entries(change)) {
    if (v === undefined) continue;
    if (v === null || v === defaults[k]) doc.deleteIn(['desktop', 'voice', k]);
    else doc.setIn(['desktop', 'voice', k], v);
  }
  const empty = (path: string[]): boolean => {
    const m = doc.getIn(path) as { items?: unknown[] } | undefined;
    return Boolean(m && Array.isArray(m.items) && m.items.length === 0);
  };
  if (empty(['desktop', 'voice'])) doc.deleteIn(['desktop', 'voice']);
  if (empty(['desktop'])) doc.deleteIn(['desktop']);
}

/** What is missing before the chosen engine can transcribe, or null when it is ready. */
export function voiceProblem(s: VoiceSettings, env: NodeJS.ProcessEnv): string | null {
  if (s.engine === 'off') return 'Voice input is off: turn it on in Settings > Voice input';
  if (s.engine === 'cloud') {
    return env[CLOUD_KEY_ENV]?.trim()
      ? null
      : `Cloud voice input needs ${CLOUD_KEY_ENV} set for your Windows user; restart the app after you set it`;
  }
  if (!s.program) return 'Pick the whisper.cpp program in Settings > Voice input';
  if (!s.model) return 'Pick a whisper.cpp model file in Settings > Voice input';
  if (!existsSync(s.program)) return `The whisper.cpp program is gone: ${s.program}`;
  if (!existsSync(s.model)) return `The whisper.cpp model file is gone: ${s.model}`;
  return null;
}

/** Whether `bytes` is a 16 kHz, 16-bit mono PCM WAV within the size limit, as the page records. */
export function wavProblem(bytes: unknown): string | null {
  if (!(bytes instanceof Uint8Array)) return 'no recording';
  if (bytes.byteLength <= 44) return 'the recording is empty';
  if (bytes.byteLength > MAX_WAV_BYTES)
    return `recordings are limited to ${MAX_SECONDS / 60} minutes`;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(12) !== 'fmt ') return 'not a WAV recording';
  const format = view.getUint16(20, true);
  const channels = view.getUint16(22, true);
  const rate = view.getUint32(24, true);
  const bits = view.getUint16(34, true);
  if (format !== 1 || channels !== 1 || rate !== 16_000 || bits !== 16) {
    return 'the recording must be 16 kHz, 16-bit mono PCM';
  }
  return null;
}

/** whisper.cpp's arguments: text only, no timestamps and no progress output. */
export function whisperArgs(model: string, wav: string, language: string): string[] {
  return ['-m', model, '-f', wav, '-l', language, '-nt', '-np'];
}

/**
 * The transcript from whisper.cpp's standard output: timestamps, and markers such as
 * `[BLANK_AUDIO]` or `(silence)` on their own, are dropped; lines join with spaces.
 */
export function transcriptText(out: string): string {
  return out
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\[\d[\d:.]*\s*-->\s*[\d:.]+\]/, '').trim())
    .filter((l) => l && !/^[[(][^\])]*[\])]$/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type Run = (
  file: string,
  args: string[],
  opts: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

const runFile: Run = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: opts.timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const last = stderr.trim().split(/\r?\n/).pop() ?? '';
          reject(new Error(`whisper.cpp failed: ${last || err.message}`));
        } else resolve({ stdout, stderr });
      },
    );
  });

/** Runs whisper.cpp on the recording in a temporary folder, which it removes afterwards. */
export async function transcribeLocal(
  s: VoiceSettings,
  wav: Uint8Array,
  run: Run = runFile,
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-ops-voice-'));
  try {
    const file = join(dir, 'speech.wav');
    writeFileSync(file, wav);
    const { stdout } = await run(s.program!, whisperArgs(s.model!, file, s.language), {
      timeout: 180_000,
    });
    return transcriptText(stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Sends the recording to OpenAI's transcription API. Only called with the cloud engine chosen. */
export async function transcribeCloud(
  s: VoiceSettings,
  wav: Uint8Array,
  key: string,
  post: typeof fetch = fetch,
): Promise<string> {
  const form = new FormData();
  form.append(
    'file',
    new Blob([wav as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }),
    'speech.wav',
  );
  form.append('model', s.cloudModel);
  form.append('response_format', 'json');
  if (s.language !== 'auto') form.append('language', s.language);
  const res = await post(CLOUD_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  const body = (await res.json().catch(() => null)) as {
    text?: unknown;
    error?: { message?: unknown };
  } | null;
  if (!res.ok) {
    const msg = typeof body?.error?.message === 'string' ? body.error.message : '';
    throw new Error(`transcription failed: HTTP ${res.status}${msg ? `: ${msg}` : ''}`);
  }
  return typeof body?.text === 'string' ? body.text.trim() : '';
}

/**
 * Whether a permission request may go through: the microphone only (no camera, no screen), only
 * for the app's own page in its own window, and only while voice input is on. Everything else is
 * refused.
 */
export function permissionAllowed(req: {
  permission: string;
  mediaTypes?: string[];
  /** The request comes from the app's window and its page URL is the app's own page. */
  ownPage: boolean;
  voiceOn: boolean;
}): boolean {
  if (req.permission !== 'media' || !req.ownPage || !req.voiceOn) return false;
  const types = req.mediaTypes ?? [];
  return types.length > 0 && types.every((t) => t === 'audio');
}
