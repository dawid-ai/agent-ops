// @vitest-environment happy-dom
// The microphone button in a composer, rendered with stand-ins for the microphone, the recorder
// and the audio decoder: a click toggles recording, a hold stops on release, the transcript goes in
// at the caret, and with voice input off nothing records.
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wavProblem } from '../src/voice';
import type { VoiceView } from '../ui/src/types';
import { MentionArea } from '../ui/src/ui/pickers';
import { setVoiceView } from '../ui/src/ui/voice';

vi.mock(import('../ui/src/api'), async (original) => ({
  ...(await original()),
  useData: <T>() => ({ data: [] as T, error: null, reload: () => {} }),
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const READY: VoiceView = {
  engine: 'local',
  program: 'C:\\w\\whisper-cli.exe',
  model: 'C:\\w\\ggml-base.bin',
  language: 'auto',
  cloudModel: 'gpt-4o-mini-transcribe',
  cloudKey: false,
  problem: null,
};

let root: Root | undefined;
let box: HTMLDivElement;
let transcribe: ReturnType<typeof vi.fn>;
let getUserMedia: ReturnType<typeof vi.fn>;
let trackStop: ReturnType<typeof vi.fn>;
let current = '';

class FakeRecorder {
  static started = 0;
  state = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start(): void {
    FakeRecorder.started++;
    this.state = 'recording';
  }
  stop(): void {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['opus']) });
    this.onstop?.();
  }
}

class FakeOfflineContext {
  async decodeAudioData(): Promise<unknown> {
    return {
      numberOfChannels: 2,
      sampleRate: 16_000,
      getChannelData: () => new Float32Array(1600).fill(0.1),
    };
  }
}

function Host() {
  const [value, setValue] = useState('Fix the');
  current = value;
  return createElement(MentionArea, { value, onChange: setValue, me: 'human:dawid' });
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
};

function mic(): HTMLButtonElement {
  const b = box.querySelector<HTMLButtonElement>('button[aria-label]');
  if (!b) throw new Error('no microphone button');
  return b;
}

function press(
  type: 'pointerdown' | 'pointerup' | 'pointercancel',
  target: EventTarget = mic(),
): void {
  act(() => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0 }));
  });
}

/** Makes the next getUserMedia call wait until the returned function is called. */
function slowMicrophone(): () => Promise<void> {
  let grant!: () => void;
  getUserMedia.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        grant = () => resolve({ getTracks: () => [{ stop: trackStop }] });
      }),
  );
  return async () => {
    grant();
    await flush();
  };
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  FakeRecorder.started = 0;
  setVoiceView(READY);
  trackStop = vi.fn();
  getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] }));
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia },
    configurable: true,
  });
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('OfflineAudioContext', FakeOfflineContext);
  transcribe = vi.fn(async () => ({ ok: true, data: { text: ' login bug ' } }));
  window.agentOps = { transcribe, voice: async () => ({ ok: true, data: READY }) } as never;
  box = document.createElement('div');
  document.body.append(box);
  root = createRoot(box);
  act(() => root!.render(createElement(Host)));
  await flush();
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.agentOps;
});

describe('microphone button', () => {
  it('records on a click, stops on the next one, and inserts the text at the caret', async () => {
    const area = box.querySelector('textarea')!;
    area.setSelectionRange(7, 7);
    press('pointerdown');
    press('pointerup');
    await flush();
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    expect(mic().getAttribute('aria-pressed')).toBe('true');
    press('pointerdown');
    await flush();
    expect(trackStop).toHaveBeenCalled();
    expect(transcribe).toHaveBeenCalledTimes(1);
    const wav = transcribe.mock.calls[0]![0] as Uint8Array;
    expect(wavProblem(wav)).toBeNull();
    expect(wav.byteLength).toBe(44 + 1600 * 2);
    expect(current).toBe('Fix the login bug');
    expect(mic().getAttribute('aria-pressed')).toBe('false');
  });

  it('stops on release after a hold', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    press('pointerdown');
    await flush();
    expect(mic().getAttribute('aria-pressed')).toBe('true');
    now.mockReturnValue(1_800);
    press('pointerup');
    await flush();
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(current).toBe('Fix the login bug');
  });

  it('stops on a release outside the button after a hold', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    press('pointerdown');
    await flush();
    expect(mic().getAttribute('aria-pressed')).toBe('true');
    now.mockReturnValue(1_800);
    press('pointerup', document.body);
    await flush();
    expect(trackStop).toHaveBeenCalled();
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(current).toBe('Fix the login bug');
  });

  it('honours a release while the microphone is still starting', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const grant = slowMicrophone();
    press('pointerdown');
    expect(mic().disabled).toBe(false);
    expect(mic().getAttribute('aria-busy')).toBe('true');
    now.mockReturnValue(1_800);
    press('pointerup');
    await grant();
    expect(FakeRecorder.started).toBe(0);
    expect(trackStop).toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
    expect(mic().getAttribute('aria-pressed')).toBe('false');
    expect(mic().getAttribute('aria-busy')).toBe('false');
  });

  it('honours a release outside the button while the microphone is still starting', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const grant = slowMicrophone();
    press('pointerdown');
    now.mockReturnValue(1_800);
    press('pointerup', document.body);
    await grant();
    expect(FakeRecorder.started).toBe(0);
    expect(trackStop).toHaveBeenCalled();
    expect(mic().getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps recording after a short click during a slow start', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const grant = slowMicrophone();
    press('pointerdown');
    now.mockReturnValue(1_100);
    press('pointerup');
    await grant();
    expect(FakeRecorder.started).toBe(1);
    expect(mic().getAttribute('aria-pressed')).toBe('true');
    press('pointerdown');
    await flush();
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it('stops when the system cancels the press', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    press('pointerdown');
    await flush();
    expect(mic().getAttribute('aria-pressed')).toBe('true');
    press('pointercancel', document.body);
    await flush();
    expect(trackStop).toHaveBeenCalled();
    expect(mic().getAttribute('aria-pressed')).toBe('false');
  });

  it('stops listening for the release once the press ends', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    press('pointerdown');
    now.mockReturnValue(1_100);
    press('pointerup');
    await flush();
    expect(mic().getAttribute('aria-pressed')).toBe('true');
    // A later long release elsewhere (another press, not ours) must not stop the recording.
    now.mockReturnValue(5_000);
    press('pointerup', document.body);
    await flush();
    expect(mic().getAttribute('aria-pressed')).toBe('true');
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('records nothing while voice input is off', async () => {
    act(() => setVoiceView({ ...READY, engine: 'off', problem: 'Voice input is off' }));
    expect(mic().title).toMatch(/off/);
    press('pointerdown');
    press('pointerup');
    await flush();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(current).toBe('Fix the');
  });

  it('frees the microphone when the composer closes mid-recording', async () => {
    press('pointerdown');
    press('pointerup');
    await flush();
    act(() => root!.unmount());
    root = undefined;
    expect(trackStop).toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
  });
});
