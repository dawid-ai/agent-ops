// Pure helpers for voice input, kept apart from the component so they can be tested.

/** The sample rate whisper.cpp expects, and the one the page records at. */
export const VOICE_RATE = 16_000;

/** Averages the channels of a recording into one. */
export function mixDown(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0]!;
  const len = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(len);
  for (const c of channels) for (let i = 0; i < len; i++) out[i]! += c[i]! / channels.length;
  return out;
}

/** A 16-bit PCM mono WAV file of `samples` (-1 to 1) at `rate`. */
export function encodeWav(samples: Float32Array, rate: number = VOICE_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(bytes.buffer);
  const tag = (at: number, s: string): void => {
    for (let i = 0; i < 4; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

/**
 * Puts spoken `text` in place of the selection `start`..`end` of `value`, with a space on each
 * side where the neighbouring text needs one. Returns the new value and the caret after the text.
 */
export function insertSpoken(
  value: string,
  start: number,
  end: number,
  text: string,
): { value: string; caret: number } {
  const said = text.trim();
  const a = Math.max(0, Math.min(start, value.length));
  const b = Math.max(a, Math.min(end, value.length));
  if (!said) return { value, caret: b };
  const before = value.slice(0, a);
  const after = value.slice(b);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const tail = after && !/^[\s.,;:!?)]/.test(after) ? ' ' : '';
  const next = `${before}${lead}${said}${tail}${after}`;
  return { value: next, caret: before.length + lead.length + said.length };
}

/**
 * A press shorter than this toggles recording (click to start, click to stop); a longer one is
 * push-to-talk and stops on release.
 */
export const HOLD_MS = 400;

/** Whether a press of `ms` milliseconds was a hold (stop on release) rather than a click. */
export function wasHold(ms: number): boolean {
  return ms >= HOLD_MS;
}

/** A message for a failed microphone start, from the DOMException name. */
export function micError(name: string): string {
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'The microphone is blocked: allow desktop apps to use it in Windows Settings > Privacy & security > Microphone';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone found';
  if (name === 'NotReadableError') return 'Another app is using the microphone';
  return 'The microphone did not start';
}
