import { useState } from 'react';
import type { SetupStatus } from '../api';
import { bridge } from '../api';
import { Button, ErrorLine, Input } from '../components';

/** First start: who you are and which data roots to load, written to the user config. */
export function Setup({
  status,
  onDone,
}: {
  status: SetupStatus;
  onDone: (restart: boolean) => void;
}) {
  const [me, setMe] = useState(status.defaults.me);
  const [roots, setRoots] = useState(status.defaults.roots.join('\n'));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = (): void => {
    setBusy(true);
    setError(null);
    const list = roots
      .split(/\r?\n/)
      .map((r) => r.trim())
      .filter(Boolean);
    bridge()
      .setup(me.trim(), list)
      .then(
        (res) => {
          setBusy(false);
          if (res.ok) onDone(res.data?.restart ?? false);
          else setError(res.error ?? 'setup failed');
        },
        (e: Error) => {
          setBusy(false);
          setError(e.message);
        },
      );
  };
  return (
    <div className="flex h-screen items-center justify-center p-8">
      <div className="w-full max-w-lg rounded-lg border border-zinc-800 bg-zinc-900/60 p-6">
        <div className="text-lg font-semibold text-zinc-100">Set up Agent Ops</div>
        <div className="mt-1 text-sm text-zinc-400">
          The app saves this to <span className="font-mono text-xs">{status.path}</span>.
        </div>
        <label className="mt-5 block text-sm text-zinc-300">
          Your id
          <Input value={me} onChange={setMe} placeholder="human:name" className="mt-1 w-full" />
        </label>
        <div className="mt-1 text-xs text-zinc-500">
          Every action you take in the app is recorded as this id.
        </div>
        {status.exists ? (
          <div className="mt-4 text-sm text-zinc-400">
            Your config file exists: the app adds your id to it and keeps everything else, its data
            roots included.
          </div>
        ) : (
          <>
            <label className="mt-4 block text-sm text-zinc-300">
              Data roots, one folder per line
              <textarea
                value={roots}
                onChange={(e) => setRoots(e.target.value)}
                rows={4}
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-200"
                placeholder="C:\\dev\\my-project"
              />
            </label>
            <div className="mt-1 text-xs text-zinc-500">
              A repo with an .agent-ops folder, or the Agent Ops Master Repo. You can add more
              later.
            </div>
          </>
        )}
        <div className="mt-4 rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-400">
          Next: click <b className="font-semibold text-zinc-200">Chat with the PM</b> at the top
          left to talk with the project&apos;s PM. It is one conversation, with no agent to pick,
          and an answer never closes it.
        </div>
        <div className="mt-3">
          <ErrorLine error={error} />
        </div>
        <div className="mt-4 flex justify-end">
          <Button kind="primary" disabled={busy || !me.trim()} onClick={save}>
            Save and start
          </Button>
        </div>
      </div>
    </div>
  );
}
