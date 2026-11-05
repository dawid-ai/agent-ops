import { describe, expect, it } from 'vitest';
import { quoteArg, runtimeDetail } from '../src/runtime-dialog';

describe('runtime dialog', () => {
  it('quotes arguments so one argument with a space differs from two', () => {
    const one = runtimeDetail({ command: 'hermes', args: ['a b'] });
    const two = runtimeDetail({ command: 'hermes', args: ['a', 'b'] });
    expect(one).toContain('Arguments: "a b"\n');
    expect(two).toContain('Arguments: a b\n');
  });

  it('quotes the way Windows splits a command line', () => {
    expect(quoteArg('--model')).toBe('--model');
    expect(quoteArg('C:\\Tools\\x.exe')).toBe('C:\\Tools\\x.exe');
    expect(quoteArg('')).toBe('""');
    expect(quoteArg('tab\there')).toBe('"tab\there"');
    expect(quoteArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteArg('C:\\My Dir\\')).toBe('"C:\\My Dir\\\\"');
    expect(quoteArg('a\\"b')).toBe('"a\\\\\\"b"');
  });

  it('shows (none) for missing lists and the removal text for null', () => {
    const d = runtimeDetail({ command: 'hermes' });
    expect(d).toContain('Program: hermes\nArguments: (none)\n');
    expect(d).toContain('Environment removed for its runs: (none)');
    expect(runtimeDetail({ command: 'x', unset_env: ['A', 'B'] })).toContain(
      'Environment removed for its runs: A, B',
    );
    expect(runtimeDetail(null)).toMatch(/^Runs on this provider stop starting/);
  });
});
