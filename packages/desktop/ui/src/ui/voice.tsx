import { LoaderCircle, Mic, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cx, toast } from '../components';
import type { VoiceView } from '../types';
import { encodeWav, micError, mixDown, VOICE_RATE, wasHold } from '../lib/voice';

// ---- Voice settings, shared by every composer -----------------------------------------------------

let cached: VoiceView | null = null;
let loading = false;
const subscribers = new Set<(v: VoiceView | null) => void>();

/** Stores new voice settings (after a change in Settings) and updates every microphone button. */
export function setVoiceView(v: VoiceView): void {
  cached = v;
  for (const fn of subscribers) fn(v);
}

/** The voice settings, read from the main process once and shared; null until they arrive. */
export function useVoice(): VoiceView | null {
  const [view, setView] = useState(cached);
  useEffect(() => {
    subscribers.add(setView);
    const b = window.agentOps;
    if (!cached && !loading && b?.voice) {
      loading = true;
      void b
        .voice()
        .then((res) => res.ok && res.data && setVoiceView(res.data))
        .finally(() => {
          loading = false;
        });
    }
    return () => {
      subscribers.delete(setView);
    };
  }, []);
  return view;
}

// ---- Recording ------------------------------------------------------------------------------------

/** The longest recording; the main process refuses longer ones. */
const MAX_MS = 295_000;

/** A recording from MediaRecorder as a 16 kHz mono WAV, resampled by the audio decoder. */
async function toWav(blob: Blob): Promise<Uint8Array> {
  const ctx = new OfflineAudioContext(1, 1, VOICE_RATE);
  const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
  const channels = Array.from({ length: audio.numberOfChannels }, (_, i) =>
    audio.getChannelData(i),
  );
  return encodeWav(mixDown(channels), audio.sampleRate);
}

interface Recording {
  recorder: MediaRecorder;
  stream: MediaStream;
  timer: ReturnType<typeof setTimeout>;
}

type Phase = 'idle' | 'starting' | 'recording' | 'working';

/**
 * The microphone button in a composer. Click to start and click again to stop, or hold it and
 * release to stop; the transcript goes to `onText`. Hidden until the voice settings arrive.
 */
export function MicButton({
  onText,
  className,
}: {
  onText: (text: string) => void;
  className?: string;
}) {
  const voice = useVoice();
  const [phase, setPhase] = useState<Phase>('idle');
  const rec = useRef<Recording | null>(null);
  const live = useRef(true);
  const pressedAt = useRef(0);
  /** Released (after a hold) while the microphone was still starting. */
  const stopWanted = useRef(false);
  /** Removes the window listeners that wait for the end of the current press. */
  const unwatch = useRef<(() => void) | null>(null);
  const textFn = useRef(onText);
  textFn.current = onText;

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      unwatch.current?.();
      unwatch.current = null;
      // Closing the composer mid-recording drops the recording and frees the microphone.
      const r = rec.current;
      rec.current = null;
      if (r) {
        clearTimeout(r.timer);
        r.recorder.onstop = null;
        if (r.recorder.state !== 'inactive') r.recorder.stop();
        for (const t of r.stream.getTracks()) t.stop();
      }
    };
  }, []);

  const finish = async (chunks: Blob[], type: string): Promise<void> => {
    try {
      if (chunks.length === 0) throw new Error('Nothing was recorded');
      const wav = await toWav(new Blob(chunks, { type }));
      const res = await window.agentOps!.transcribe(wav);
      if (!res.ok) throw new Error(res.error ?? 'Transcription failed');
      const text = res.data?.text.trim() ?? '';
      if (!text) toast('No speech heard', { tone: 'bad' });
      else if (live.current) textFn.current(text);
    } catch (err) {
      toast((err as Error).message, { tone: 'bad' });
    } finally {
      if (live.current) setPhase('idle');
    }
  };

  const stop = (): void => {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    clearTimeout(r.timer);
    if (r.recorder.state !== 'inactive') r.recorder.stop();
    for (const t of r.stream.getTracks()) t.stop();
    setPhase('working');
  };

  const start = async (): Promise<void> => {
    if (!voice) return;
    if (voice.problem) {
      toast(voice.problem, { tone: 'bad' });
      return;
    }
    stopWanted.current = false;
    setPhase('starting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      if (live.current) setPhase('idle');
      toast(micError((err as DOMException).name), { tone: 'bad' });
      return;
    }
    if (!live.current || stopWanted.current) {
      // A hold that ended before the microphone was ready recorded nothing.
      for (const t of stream.getTracks()) t.stop();
      if (live.current) {
        setPhase('idle');
        toast('Released before the microphone was ready', { tone: 'bad' });
      }
      return;
    }
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => void finish(chunks, recorder.mimeType);
    recorder.start();
    rec.current = { recorder, stream, timer: setTimeout(stop, MAX_MS) };
    setPhase('recording');
  };

  /**
   * The press that started a recording ended. A hold stops it; a short press leaves it on, to stop
   * on the next click. A cancelled press (the system took the pointer, the window lost focus)
   * always stops, so the microphone never stays on after a gesture you did not finish.
   */
  const released = (cancelled: boolean): void => {
    unwatch.current?.();
    unwatch.current = null;
    if (!pressedAt.current) return;
    const held = cancelled || wasHold(Date.now() - pressedAt.current);
    pressedAt.current = 0;
    if (!held) return;
    if (rec.current) stop();
    else stopWanted.current = true;
  };

  /**
   * Waits for the end of a press on the window, not on the button: the release can land outside
   * the button, or while the microphone is still starting.
   */
  const watchRelease = (pointerId: number): void => {
    unwatch.current?.();
    const onUp = (e: PointerEvent) => e.pointerId === pointerId && released(false);
    const onCancel = (e: PointerEvent) => e.pointerId === pointerId && released(true);
    const onBlur = () => released(true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    window.addEventListener('blur', onBlur);
    unwatch.current = () => {
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
      window.removeEventListener('blur', onBlur);
    };
  };

  if (!voice) return null;
  const off = voice.engine === 'off';
  const title =
    phase === 'recording'
      ? 'Stop and insert the text'
      : phase === 'starting'
        ? 'Starting the microphone…'
        : phase === 'working'
          ? 'Turning speech into text…'
          : off
            ? 'Voice input is off: turn it on in Settings > Voice input'
            : 'Speak: click to start and stop, or hold to talk';
  const Icon = phase === 'recording' ? Square : phase === 'working' ? LoaderCircle : Mic;
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={phase === 'recording'}
      // Not disabled while starting: a disabled button would swallow the release of a hold.
      aria-busy={phase === 'starting'}
      disabled={phase === 'working'}
      // The textarea keeps its focus and caret, so the text lands where you were typing.
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        if (phase === 'recording') return stop();
        if (phase !== 'idle') return;
        pressedAt.current = Date.now();
        watchRelease(e.pointerId);
        void start();
      }}
      onClick={(e) => {
        // Keyboard presses (Enter, Space) report no clicks: they toggle.
        if (e.detail !== 0) return;
        if (phase === 'recording') stop();
        else if (phase === 'idle') void start();
      }}
      className={cx(
        'grid h-7 w-7 place-items-center rounded-md transition',
        phase === 'recording'
          ? 'animate-pulse bg-bad/20 text-bad'
          : off
            ? 'text-fg-4 hover:bg-white/5 hover:text-fg-3'
            : 'text-fg-3 hover:bg-white/8 hover:text-signal',
        'disabled:cursor-wait aria-busy:cursor-wait',
        className,
      )}
    >
      <Icon size={15} className={phase === 'working' ? 'animate-spin' : undefined} />
    </button>
  );
}
