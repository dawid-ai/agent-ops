/** Where a click on an inbox item leads; the same routing as the Inbox view in the renderer. */
export function inboxTarget(it: { kind: string; task: string }): { view: string; id?: string } {
  if (it.kind === 'vote' || it.kind === 'decide') return { view: 'decisions' };
  if (it.task.startsWith('#')) return { view: 'channels', id: it.task.slice(1) };
  return { view: 'task', id: it.task };
}
