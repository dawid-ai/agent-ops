// Times `ops next` as a fresh process against a root with many tasks (phase 1 target: < 200 ms).
//   node scripts/bench-next.mjs [TASKS] [RUNS]
// Needs a build (`npm run build`). Uses a temp folder and removes it afterwards.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const { initRoot, Workspace } = await import(
  pathToFileURL(join(repo, 'packages/core/dist/index.js')).href
);
const cli = join(repo, 'packages/cli/dist/main.js');
const tasks = Number(process.argv[2] ?? 1000);
const runs = Number(process.argv[3] ?? 10);

const dir = mkdtempSync(join(tmpdir(), 'ops-bench-'));
try {
  execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
  initRoot(dir, { name: 'bench', human: 'human:dawid' });
  const env = { ...process.env, OPS_CONFIG: join(dir, 'none.yml') };
  const human = new Workspace({ cwd: dir, env, actor: 'human:dawid' });
  for (let i = 0; i < tasks; i++) human.newTask({ title: `task ${i}`, priority: `p${i % 4}` });
  // Give most tasks some history: claim, start, progress, done on 3 of 4.
  const agent = new Workspace({ cwd: dir, env, actor: 'claude:engineer' });
  for (let i = 1; i <= tasks; i++) {
    if (i % 4 === 0) continue;
    agent.start(String(i));
    agent.progress(String(i), 'halfway');
    agent.done(String(i), 'ok');
  }
  const time = () => {
    const t = process.hrtime.bigint();
    execFileSync(process.execPath, [cli, 'next'], {
      cwd: dir,
      env: { ...env, OPS_AGENT: 'codex:engineer' },
      windowsHide: true,
    });
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  const cold = time();
  const warm = Array.from({ length: runs }, time).sort((a, b) => a - b);
  const median = warm[Math.floor(warm.length / 2)];
  const node = (() => {
    const t = process.hrtime.bigint();
    execFileSync(process.execPath, ['-e', '0'], { windowsHide: true });
    return Number(process.hrtime.bigint() - t) / 1e6;
  })();
  console.log(
    `tasks ${tasks}, cold ${cold.toFixed(0)} ms, warm median ${median.toFixed(0)} ms (min ${warm[0].toFixed(0)}, max ${warm.at(-1).toFixed(0)}), bare node start ${node.toFixed(0)} ms`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
