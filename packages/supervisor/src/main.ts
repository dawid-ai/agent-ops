#!/usr/bin/env node
import { OpsError } from '@agent-ops/core';
import { readDaemon, runDaemon, startDaemon, stopDaemon } from './daemon.js';

const USAGE = `opsd: the Agent Ops supervisor

Usage:
  opsd run [--port N]       run in this terminal until Ctrl+C
  opsd start [--port N]     run in the background (no window); log in <state>/opsd.log
  opsd stop [--kill-runs]   stop it; runs keep going unless --kill-runs
  opsd status               print pid, port and version`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const portAt = rest.indexOf('--port');
  const port = portAt >= 0 ? Number(rest[portAt + 1]) : undefined;
  if (port !== undefined && !Number.isInteger(port)) throw new OpsError('bad --port', 2);
  switch (cmd) {
    case 'run':
      await runDaemon({ port });
      return 0;
    case 'start': {
      const info = await startDaemon({ port });
      process.stdout.write(`opsd pid ${info.pid} on 127.0.0.1:${info.port}\n`);
      return 0;
    }
    case 'stop': {
      const stopped = await stopDaemon({ killRuns: rest.includes('--kill-runs') });
      process.stdout.write(stopped ? 'opsd stopped\n' : 'opsd is not running\n');
      return 0;
    }
    case 'status': {
      const info = readDaemon();
      process.stdout.write(
        info
          ? `opsd ${info.version} pid ${info.pid} on 127.0.0.1:${info.port} since ${info.started_at}\n`
          : 'opsd is not running\n',
      );
      return info ? 0 : 3;
    }
    default:
      process.stdout.write(`${USAGE}\n`);
      return cmd && cmd !== 'help' && cmd !== '--help' ? 2 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`opsd: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = err instanceof OpsError ? err.code : 1;
  },
);
