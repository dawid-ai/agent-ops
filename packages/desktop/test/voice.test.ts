import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  checkVoicePatch,
  CLOUD_URL,
  MAX_WAV_BYTES,
  permissionAllowed,
  transcribeCloud,
  transcribeLocal,
  transcriptText,
  voiceProblem,
  voiceSettings,
  wavProblem,
  whisperArgs,
  writeVoice,
} from '../src/voice';
import { encodeWav, insertSpoken, micError, mixDown, wasHold } from '../ui/src/lib/voice';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'voice-test-'));
  dirs.push(d);
  return d;
}

describe('voice settings', () => {
  it('defaults to off, with automatic language and the default cloud model', () => {
    expect(voiceSettings({})).toEqual({
      engine: 'off',
      program: null,
      model: null,
      language: 'auto',
      cloudModel: 'gpt-4o-mini-transcribe',
    });
    expect(voiceSettings(null).engine).toBe('off');
  });

  it('reads desktop.voice and ignores values it cannot use', () => {
    const s = voiceSettings({
      desktop: {
        voice: {
          engine: 'local',
          program: ' C:\\w\\whisper-cli.exe ',
          model: 'C:\\w\\ggml-base.bin',
          language: 'PL',
          cloud_model: 'whisper-1',
        },
      },
    });
    expect(s).toEqual({
      engine: 'local',
      program: 'C:\\w\\whisper-cli.exe',
      model: 'C:\\w\\ggml-base.bin',
      language: 'pl',
      cloudModel: 'whisper-1',
    });
    const bad = voiceSettings({ desktop: { voice: { engine: 'loud', language: 'polish!' } } });
    expect(bad.engine).toBe('off');
    expect(bad.language).toBe('auto');
  });

  it('accepts only an engine and a language from the page', () => {
    expect(checkVoicePatch({ engine: 'cloud', language: ' EN ' })).toEqual({
      engine: 'cloud',
      language: 'en',
    });
    // The page can never name the program the app starts.
    expect(checkVoicePatch({ program: 'C:\\evil.exe' })).toEqual({});
    expect(() => checkVoicePatch({ engine: 'shell' })).toThrow(/off, local or cloud/);
    expect(() => checkVoicePatch({ language: 'english please' })).toThrow(/language/);
  });

  it('writes under desktop.voice, keeps other keys and comments, and drops defaults', () => {
    const doc = YAML.parseDocument('# mine\nme: human:dawid\ndesktop:\n  notify: false\n');
    writeVoice(doc, { engine: 'local', program: 'C:\\w\\whisper-cli.exe', language: 'pl' });
    expect(doc.toJS()).toEqual({
      me: 'human:dawid',
      desktop: {
        notify: false,
        voice: { engine: 'local', program: 'C:\\w\\whisper-cli.exe', language: 'pl' },
      },
    });
    expect(doc.toString()).toContain('# mine');
    writeVoice(doc, { engine: 'off', language: 'auto', program: null });
    expect(doc.toJS()).toEqual({ me: 'human:dawid', desktop: { notify: false } });
    const bare = YAML.parseDocument('me: human:dawid\n');
    writeVoice(bare, { engine: 'cloud' });
    writeVoice(bare, { engine: 'off' });
    expect(bare.toJS()).toEqual({ me: 'human:dawid' });
  });

  it('says what is missing before each engine can transcribe', () => {
    const base = voiceSettings({});
    expect(voiceProblem(base, {})).toMatch(/off/);
    expect(voiceProblem({ ...base, engine: 'cloud' }, {})).toMatch(/OPENAI_API_KEY/);
    expect(voiceProblem({ ...base, engine: 'cloud' }, { OPENAI_API_KEY: 'x' })).toBeNull();
    expect(voiceProblem({ ...base, engine: 'local' }, {})).toMatch(/program/);
    const d = scratch();
    const program = join(d, 'whisper-cli.exe');
    const model = join(d, 'ggml-base.bin');
    writeFileSync(program, '');
    expect(voiceProblem({ ...base, engine: 'local', program }, {})).toMatch(/model file/);
    expect(voiceProblem({ ...base, engine: 'local', program, model }, {})).toMatch(/gone/);
    writeFileSync(model, '');
    expect(voiceProblem({ ...base, engine: 'local', program, model }, {})).toBeNull();
  });
});

describe('recordings', () => {
  it('encodes 16 kHz 16-bit mono WAV that the main process accepts', () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 2, -2]));
    expect(wav.byteLength).toBe(44 + 10);
    expect(wavProblem(wav)).toBeNull();
    const v = new DataView(wav.buffer);
    expect(v.getInt16(46, true)).toBe(Math.trunc(0.5 * 0x7fff));
    expect(v.getInt16(48, true)).toBe(-0x4000);
    // Out-of-range samples clip instead of wrapping around.
    expect(v.getInt16(50, true)).toBe(0x7fff);
    expect(v.getInt16(52, true)).toBe(-0x8000);
  });

  it('refuses anything else', () => {
    expect(wavProblem('RIFF')).toMatch(/no recording/);
    expect(wavProblem(encodeWav(new Float32Array(0)))).toMatch(/empty/);
    expect(wavProblem(encodeWav(new Float32Array(10), 44_100))).toMatch(/16 kHz/);
    const junk = encodeWav(new Float32Array(10));
    junk[0] = 0x58;
    expect(wavProblem(junk)).toMatch(/not a WAV/);
    expect(wavProblem(new Uint8Array(MAX_WAV_BYTES + 2))).toMatch(/5 minutes/);
  });

  it('mixes channels down to one', () => {
    const one = new Float32Array([0.25]);
    expect(mixDown([one])).toBe(one);
    expect(
      Array.from(mixDown([new Float32Array([1, 0.5]), new Float32Array([0, 0.5, 9])])),
    ).toEqual([0.5, 0.5]);
    expect(mixDown([]).length).toBe(0);
  });
});

describe('inserting spoken text', () => {
  it('goes in at the caret with spaces where the neighbours need them', () => {
    expect(insertSpoken('', 0, 0, ' hello ')).toEqual({ value: 'hello', caret: 5 });
    expect(insertSpoken('Fix the', 7, 7, 'login bug')).toEqual({
      value: 'Fix the login bug',
      caret: 17,
    });
    expect(insertSpoken('Fix  now', 4, 4, 'it')).toEqual({ value: 'Fix it now', caret: 6 });
    expect(insertSpoken('Fixnow', 3, 3, 'it')).toEqual({ value: 'Fix it now', caret: 6 });
    // No space before punctuation that follows.
    expect(insertSpoken('Done.', 4, 4, 'and tested')).toEqual({
      value: 'Done and tested.',
      caret: 15,
    });
  });

  it('replaces a selection, and changes nothing for empty speech', () => {
    expect(insertSpoken('ask codex now', 4, 9, 'claude')).toEqual({
      value: 'ask claude now',
      caret: 10,
    });
    expect(insertSpoken('keep', 2, 2, '   ')).toEqual({ value: 'keep', caret: 2 });
    expect(insertSpoken('ab', 9, 9, 'c')).toEqual({ value: 'ab c', caret: 4 });
  });

  it('tells a click from a hold, and names microphone failures', () => {
    expect(wasHold(150)).toBe(false);
    expect(wasHold(600)).toBe(true);
    expect(micError('NotAllowedError')).toMatch(/Privacy & security > Microphone/);
    expect(micError('NotFoundError')).toBe('No microphone found');
    expect(micError('Whatever')).toBe('The microphone did not start');
  });
});

describe('whisper.cpp', () => {
  it('asks for text only', () => {
    expect(whisperArgs('m.bin', 'a.wav', 'pl')).toEqual([
      '-m',
      'm.bin',
      '-f',
      'a.wav',
      '-l',
      'pl',
      '-nt',
      '-np',
    ]);
  });

  it('keeps the words and drops timestamps and markers', () => {
    expect(transcriptText(' Hello there.\r\n And more.\n')).toBe('Hello there. And more.');
    expect(
      transcriptText('[00:00:00.000 --> 00:00:02.000]   Hi.\n[BLANK_AUDIO]\n(silence)\n'),
    ).toBe('Hi.');
    expect(transcriptText('\n [BLANK_AUDIO]\n')).toBe('');
  });

  it('runs the program on a temporary WAV and removes it afterwards', async () => {
    const s = { ...voiceSettings({}), engine: 'local' as const, program: 'w.exe', model: 'm.bin' };
    const wav = encodeWav(new Float32Array(160));
    let seen: { file: string; args: string[]; bytes: Buffer } | null = null;
    const text = await transcribeLocal(s, wav, async (file, args) => {
      seen = { file, args, bytes: readFileSync(args[3]!) };
      return { stdout: ' Ship it.\n', stderr: '' };
    });
    expect(text).toBe('Ship it.');
    expect(seen!.file).toBe('w.exe');
    expect(seen!.args.slice(0, 2)).toEqual(['-m', 'm.bin']);
    expect(Buffer.compare(seen!.bytes, Buffer.from(wav))).toBe(0);
    expect(existsSync(seen!.args[3]!)).toBe(false);
  });

  it('removes the temporary WAV when the program fails', async () => {
    const s = { ...voiceSettings({}), engine: 'local' as const, program: 'w.exe', model: 'm.bin' };
    let path = '';
    await expect(
      transcribeLocal(s, encodeWav(new Float32Array(16)), async (_f, args) => {
        path = args[3]!;
        throw new Error('whisper.cpp failed: bad model');
      }),
    ).rejects.toThrow(/bad model/);
    expect(existsSync(path)).toBe(false);
  });
});

describe('cloud transcription', () => {
  const s = { ...voiceSettings({}), engine: 'cloud' as const, language: 'pl' };

  it('posts the WAV with the model and language and returns the text', async () => {
    let req: { url: string; init: RequestInit } | null = null;
    const post = (async (url: string, init: RequestInit) => {
      req = { url, init };
      return new Response(JSON.stringify({ text: ' Cześć. ' }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await transcribeCloud(s, encodeWav(new Float32Array(16)), 'k', post)).toBe('Cześć.');
    expect(req!.url).toBe(CLOUD_URL);
    expect((req!.init.headers as Record<string, string>).authorization).toBe('Bearer k');
    const form = req!.init.body as FormData;
    expect(form.get('model')).toBe('gpt-4o-mini-transcribe');
    expect(form.get('language')).toBe('pl');
    expect((form.get('file') as File).type).toBe('audio/wav');
  });

  it('leaves the language out on auto and reports API errors', async () => {
    let form: FormData | null = null;
    const post = (async (_url: string, init: RequestInit) => {
      form = init.body as FormData;
      return new Response(JSON.stringify({ error: { message: 'Invalid file' } }), { status: 400 });
    }) as unknown as typeof fetch;
    await expect(
      transcribeCloud({ ...s, language: 'auto' }, encodeWav(new Float32Array(16)), 'k', post),
    ).rejects.toThrow('transcription failed: HTTP 400: Invalid file');
    expect(form!.has('language')).toBe(false);
  });
});

describe('permissions', () => {
  const ok = { permission: 'media', mediaTypes: ['audio'], ownPage: true, voiceOn: true };

  it('lets the own page use the microphone while voice input is on', () => {
    expect(permissionAllowed(ok)).toBe(true);
  });

  it('refuses the camera, other pages, other permissions, and everything while off', () => {
    expect(permissionAllowed({ ...ok, mediaTypes: ['audio', 'video'] })).toBe(false);
    expect(permissionAllowed({ ...ok, mediaTypes: ['video'] })).toBe(false);
    expect(permissionAllowed({ ...ok, mediaTypes: [] })).toBe(false);
    expect(permissionAllowed({ ...ok, ownPage: false })).toBe(false);
    expect(permissionAllowed({ ...ok, voiceOn: false })).toBe(false);
    expect(permissionAllowed({ ...ok, permission: 'notifications' })).toBe(false);
    expect(permissionAllowed({ ...ok, permission: 'geolocation' })).toBe(false);
  });
});
