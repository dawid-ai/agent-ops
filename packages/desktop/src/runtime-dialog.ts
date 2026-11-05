// Kept apart from main.ts so it can be tested without Electron.

/**
 * One argument as it appears on a Windows command line, quoted the way Node's spawn quotes it: only
 * when it is empty or has a space, tab or quote, with backslashes doubled before a quote and at
 * the end. ['a b'] shows as "a b" and ['a', 'b'] as a b.
 */
export function quoteArg(a: string): string {
  if (a !== '' && !/[\s"]/.test(a)) return a;
  let out = '"';
  let slashes = 0;
  for (const ch of a) {
    if (ch === '\\') {
      slashes++;
      continue;
    }
    out += '\\'.repeat(ch === '"' ? slashes * 2 + 1 : slashes) + ch;
    slashes = 0;
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`;
}

/** The detail text of the dialog that confirms adding (`rc`) or removing (`null`) a provider. */
export function runtimeDetail(
  rc: { command: string; args?: string[]; unset_env?: string[] } | null,
): string {
  if (rc === null) return 'Runs on this provider stop starting. Live runs go on. Role files stay.';
  const args = rc.args?.length ? rc.args.map(quoteArg).join(' ') : '(none)';
  return [
    `Program: ${rc.command}`,
    `Arguments: ${args}`,
    `Environment removed for its runs: ${rc.unset_env?.join(', ') || '(none)'}`,
    '',
    'Agent runs on this provider start this program with your user rights, in the',
    "project's folder, with the task prompt on standard input.",
  ].join('\n');
}
