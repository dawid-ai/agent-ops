import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DesktopView,
  Info,
  ServiceAction,
  ServiceState,
  UpdateState,
  VoiceView,
} from './types';

export interface SetupStatus {
  needed: boolean;
  /** A config file exists without `me`: setup adds only `me` and keeps its roots. */
  exists: boolean;
  path: string;
  defaults: { me: string; roots: string[] };
}

interface Bridge {
  info: () => Promise<Info>;
  setupStatus: () => Promise<SetupStatus>;
  /** Restarts opsd while no run is live, so it loads the installed build and config. */
  restart: () => Promise<{ ok: boolean; data?: { pid: number; port: number }; error?: string }>;
  /**
   * Adds or replaces a provider runtime, or removes it with `null`, after the person confirms the
   * command in a system dialog. Resolves `{ ok: false, error: 'cancelled' }` when they decline.
   */
  runtime: (
    name: string,
    input: { command: string; args?: string[]; unset_env?: string[] } | null,
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Starts, stops, restarts, pauses or resumes opsd; stop and restart never stop a run. */
  service: (action: ServiceAction) => Promise<{ ok: boolean; data?: ServiceState; error?: string }>;
  desktop: () => Promise<{ ok: boolean; data?: DesktopView; error?: string }>;
  /** `login` adds the app to the Windows sign-in apps or removes it. */
  desktopSet: (patch: {
    notify?: boolean;
    login?: boolean;
  }) => Promise<{ ok: boolean; data?: DesktopView; error?: string }>;
  onService: (fn: (m: unknown) => void) => () => void;
  voice: () => Promise<{ ok: boolean; data?: VoiceView; error?: string }>;
  /** Choosing `cloud` asks in a system dialog first; resolves `cancelled` when declined. */
  voiceSet: (patch: {
    engine?: VoiceView['engine'];
    language?: string;
  }) => Promise<{ ok: boolean; data?: VoiceView; error?: string }>;
  /** Picks whisper.cpp's program or model file in a system dialog. */
  voiceBrowse: (
    kind: 'program' | 'model',
  ) => Promise<{ ok: boolean; data?: VoiceView; error?: string }>;
  /** Turns a 16 kHz mono WAV recording into text with the chosen engine. */
  transcribe: (
    wav: Uint8Array,
  ) => Promise<{ ok: boolean; data?: { text: string }; error?: string }>;
  /** The update state; `check` looks now, `install` installs a downloaded update (asks first while runs are live). */
  update: (
    action?: 'check' | 'install',
  ) => Promise<{ ok: boolean; data?: UpdateState; error?: string }>;
  onUpdate: (fn: (m: unknown) => void) => () => void;
  setup: (
    me: string,
    roots: string[],
  ) => Promise<{ ok: boolean; data?: { path: string; restart: boolean }; error?: string }>;
  call: (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  onEvent: (fn: (m: unknown) => void) => () => void;
  onStatus: (fn: (m: unknown) => void) => () => void;
  onNavigate: (fn: (m: unknown) => void) => () => void;
}

declare global {
  interface Window {
    agentOps?: Bridge;
  }
}

/** The update state, kept current by the main process. */
export function useUpdate(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    let live = true;
    const b = window.agentOps;
    if (!b?.update) return;
    void b.update().then((res) => live && res.ok && res.data && setState(res.data));
    const off = b.onUpdate((m) => live && setState(m as UpdateState));
    return () => {
      live = false;
      off();
    };
  }, []);
  return state;
}

export function bridge(): Bridge {
  if (!window.agentOps) throw new Error('Agent Ops runs inside the desktop app only');
  return window.agentOps;
}

/** The `warnings` an opsd response carries (a write that went through but reaches no agent). */
export function warningsOf(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const w = (data as { warnings?: unknown }).warnings;
  return Array.isArray(w) ? w.filter((x): x is string => typeof x === 'string' && x !== '') : [];
}

type WarnFn = (warnings: string[]) => void;
const warnListeners = new Set<WarnFn>();

/** Calls `fn` with the warnings of every write response; returns the unsubscribe function. */
export function onWarnings(fn: WarnFn): () => void {
  warnListeners.add(fn);
  return () => {
    warnListeners.delete(fn);
  };
}

export async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await bridge().call(method, path, body);
  if (!res.ok) throw new Error(res.error ?? 'request failed');
  // Every write passes through here, so no view can drop a warning by ignoring the response.
  const warnings = method === 'POST' ? warningsOf(res.data) : [];
  if (warnings.length > 0) for (const fn of warnListeners) fn(warnings);
  return res.data as T;
}

// One shared refresh signal: opsd events (tasks changed, a run changed) bump it, and every view
// that reads data refetches.
type Fn = () => void;
const listeners = new Set<Fn>();
let timer: ReturnType<typeof setTimeout> | undefined;

export function refreshSoon(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    for (const fn of listeners) fn();
  }, 250);
}

export function useRefresh(fn: Fn): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const h = (): void => ref.current();
    listeners.add(h);
    return () => {
      listeners.delete(h);
    };
  }, []);
}

/** GETs `path` now, again on every refresh signal, and when `path` changes. */
export function useData<T>(path: string | null): {
  data: T | undefined;
  error: string | null;
  reload: () => void;
} {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  // Every request gets a number; only the newest one may set state, so a slow answer for an
  // earlier path never shows up under a later one.
  const seq = useRef(0);
  const load = useCallback(() => {
    if (!path) return;
    const mine = ++seq.current;
    api<T>('GET', path).then(
      (d) => {
        if (mine !== seq.current) return;
        setData(d);
        setError(null);
      },
      (e: Error) => {
        if (mine === seq.current) setError(e.message);
      },
    );
  }, [path]);
  useEffect(() => {
    setData(undefined);
    setError(null);
    load();
  }, [load]);
  useRefresh(load);
  return { data, error, reload: load };
}

export function q(s: string): string {
  return encodeURIComponent(s);
}
