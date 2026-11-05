import { describe, expect, it } from 'vitest';
import { CLAUDE_DENY } from '../src/index.js';

/** Claude Code's rule match for one Bash command: `*` stands for any text, the rest is literal. */
function denied(command: string): boolean {
  return CLAUDE_DENY.some((rule) => {
    const body = rule.slice('Bash('.length, -1);
    const pattern = body
      .split('*')
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${pattern}$`).test(command);
  });
}

describe('Claude deny list', () => {
  it.each([
    'git push --force',
    'git push -f origin main',
    'git push origin main --force',
    'git push origin main --force-with-lease',
    'git push origin main -f',
    'git push origin +main',
    'git push +main',
    'rm -rf /',
    'rm -fr /',
    'rm -Rf /',
    'rm -r -f /',
    'rm -f -r /',
    'rm --recursive --force /',
    'kill -9 1234',
    'kill 1234',
    'taskkill /F /IM node.exe',
    'pkill node',
    'killall node',
    'Stop-Process -Name node',
    'stop-process -name node',
    'Get-Process node | Stop-Process',
    'get-process node | stop-process',
    'pwsh -c "Stop-Process -Id 1234"',
    'pwsh -c "Get-Process node | Stop-Process"',
    'powershell -Command Stop-Process -Name node',
    'cmd /c taskkill /F /IM node.exe',
  ])('denies %s', (command) => {
    expect(denied(command)).toBe(true);
  });

  it.each([
    'git push',
    'git push -u origin claude/ao-0087',
    'git push origin HEAD',
    'rm -rf dist',
    'rm -rf packages/cli/dist',
    'npm test',
    'ops sync --session-end',
  ])('allows %s', (command) => {
    expect(denied(command)).toBe(false);
  });
});
