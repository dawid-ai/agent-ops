// Stand-in for the claude and codex runtimes in the promo's scratch opsd. opsd starts it like a
// real run (prompt on stdin, OPS_AGENT and the run token in the environment). It finds its task in
// the prompt and runs the `ops` steps planned for that task in plan.json; a step `['@', name]`
// waits until the file <signals>/<name> exists, so the capture script decides when a run moves on.
// It prints Claude stream-json or Codex --json lines with token usage, so runs count tokens.
// Usage: node fake-agent.mjs <cli main.js> <plan.json> <signals dir>
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const [cli, planFile, signals] = process.argv.slice(2);
const codex = (process.env.OPS_AGENT ?? '').startsWith('codex:');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (prompt += d));
await Promise.race([new Promise((r) => process.stdin.on('end', r)), sleep(3000)]);
const task = (prompt.match(/\b(?:SHOP|DOCS)-\d{4}\b/) ?? [])[0];
const plan = (task && JSON.parse(readFileSync(planFile, 'utf8'))[task]) || [];
const say = (o) => console.log(JSON.stringify(o));
const usage = () => ({
  input_tokens: 9000 + Math.floor(Math.random() * 21000),
  output_tokens: 600 + Math.floor(Math.random() * 2400),
});
const total = { input_tokens: 0, output_tokens: 0 };
let n = 0;
say(codex ? { type: 'turn.started' } : { type: 'system', subtype: 'init', model: 'demo' });
// Up to 10 minutes, so a run the script forgets cannot outlive it for long.
const deadline = Date.now() + 600_000;
for (const step of plan) {
  if (step[0] === '@') {
    while (!existsSync(join(signals, step[1])) && Date.now() < deadline) await sleep(100);
    continue;
  }
  await sleep(200);
  const u = usage();
  total.input_tokens += u.input_tokens;
  total.output_tokens += u.output_tokens;
  const text = `ops ${step.join(' ')}`;
  if (codex) {
    say({ type: 'item.completed', item: { type: 'command_execution', command: text } });
    say({ type: 'turn.completed', usage: { ...u, cached_input_tokens: 0 } });
  } else {
    say({
      type: 'assistant',
      message: { id: `msg_${++n}`, usage: u, content: [{ type: 'text', text }] },
    });
  }
  const r = spawnSync(process.execPath, [cli, ...step], {
    env: process.env,
    encoding: 'utf8',
    windowsHide: true,
  });
  console.log((r.stdout || '') + (r.stderr || ''));
}
await sleep(300);
if (!codex) say({ type: 'result', subtype: 'success', usage: total, result: 'Done.' });
