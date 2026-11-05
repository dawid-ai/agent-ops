import type { AgentDef } from '@agent-ops/core';
import { actorSlug, runtimeOf } from '@agent-ops/core';
import type { RuntimeConfig } from './config.js';
import { checkModel } from './config.js';

/** Tools for a Claude role that lists none: edit, read and the usual dev commands. */
export const DEFAULT_CLAUDE_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Edit',
  'Write',
  'Bash(git *)',
  'Bash(npm *)',
  'Bash(npx *)',
  'Bash(node *)',
  'Bash(gh pr *)',
  'Bash(gh issue view *)',
  'Bash(gh run *)',
];

/**
 * Never allowed for a supervised Claude run (v1 lesson: kills by name took out other runs).
 * The list catches mistakes, not a determined run: the default allow list has `node`, `npx` and
 * `git`, and any of them can run a command this list never sees.
 */
export const CLAUDE_DENY = [
  // Force push: the flag before or after the refspec, or a `+` refspec.
  'Bash(git push --force*)',
  'Bash(git push -f*)',
  'Bash(git push * --force*)',
  'Bash(git push * -f*)',
  'Bash(git push +*)',
  'Bash(git push * +*)',
  // Recursive delete from an absolute path, in any flag order.
  'Bash(rm -rf /*)',
  'Bash(rm -fr /*)',
  'Bash(rm -Rf /*)',
  'Bash(rm -fR /*)',
  'Bash(rm -r -f /*)',
  'Bash(rm -f -r /*)',
  'Bash(rm -R -f /*)',
  'Bash(rm -f -R /*)',
  'Bash(rm --recursive --force /*)',
  'Bash(rm --force --recursive /*)',
  // Ending processes by PID, by name, or through PowerShell or cmd.
  'Bash(kill *)',
  'Bash(taskkill*)',
  'Bash(pkill*)',
  'Bash(killall*)',
  'Bash(Stop-Process*)',
  'Bash(stop-process*)',
  'Bash(*| Stop-Process*)',
  'Bash(*|Stop-Process*)',
  'Bash(*| stop-process*)',
  'Bash(*|stop-process*)',
  'Bash(pwsh*Stop-Process*)',
  'Bash(pwsh*stop-process*)',
  'Bash(powershell*Stop-Process*)',
  'Bash(powershell*stop-process*)',
  'Bash(pwsh*taskkill*)',
  'Bash(powershell*taskkill*)',
  'Bash(cmd*taskkill*)',
];

/**
 * Denied to a Claude run that starts in a data root's checkout (AO-0135): switching its branch
 * puts the task store on a code branch. Code branches go in worktrees instead. Like
 * {@link CLAUDE_DENY}, this catches mistakes: `git -C <dir> checkout` passes, and that is how a
 * run switches branches inside its own worktree.
 */
export const STORE_CHECKOUT_DENY = ['Bash(git checkout*)', 'Bash(git switch*)'];

/** Denied to a run of a role that does not write (AO-0136), whatever its role file lists. */
export const READ_ONLY_DENY = ['Edit', 'Write', 'NotebookEdit'];

/** Tools of a chat turn whose role file lists none: it reads and acts through `ops` only. */
export const CHAT_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git log *)', 'Bash(git show *)'];

/** A chat turn never gives a verdict or decides a vote: those stay with reviewers and people. */
export const CHAT_DENY = ['Bash(ops verdict*)', 'Bash(ops decide*)', 'Edit', 'Write'];

/** A Claude chat turn: the session it starts or resumes, with replies streamed as they come. */
export interface ChatInvocation {
  session: string;
  resume: boolean;
}

export interface Invocation {
  args: string[];
  unsetEnv: string[];
  /** Lines the run's prompt must end with, because of how the run starts. */
  note?: string;
}

/**
 * Where a Codex run of a role that does not write starts, and what it may write (AO-0138). The
 * sandbox always lets Codex write its working folder, so the run starts in its task store, not in
 * the checkout: `ops` writes there, and the checkout stays read-only. The other stores are added
 * as writable folders. `stores` lists the run's own store first; stores inside another one are
 * dropped, since the outer one covers them.
 */
function codexReadOnlyDirs(stores: string[]): { cd: string; add: string[] } | null {
  const outer = stores.filter(
    (s, i) => !stores.some((o, j) => j !== i && containsPath(o, s) && (!sameDir(o, s) || j < i)),
  );
  if (outer.length === 0) return null;
  return { cd: outer[0]!, add: outer.slice(1) };
}

/** The prompt lines of a read-only Codex run that starts in its task store. */
export function readOnlyCodexNote(checkout: string, store: string): string {
  return [
    '',
    `This run may not change files in ${checkout}: Codex starts you in the task store (${store}),`,
    'the only place you can write, and `ops` works there. Read the code by path and run git with',
    `\`git -C ${checkout} ...\`.`,
    '',
  ].join('\n');
}

function normalDir(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s;
}

function sameDir(a: string, b: string): boolean {
  return normalDir(a) === normalDir(b);
}

/** True when `child` is `parent` or a folder inside it. */
function containsPath(parent: string, child: string): boolean {
  const p = normalDir(parent);
  const c = normalDir(child);
  return c === p || c.startsWith(`${p}/`);
}

/** Claude permission paths use // for absolute paths and /c/... for Windows drives. */
function claudeAbsolutePattern(dir: string): string {
  const normalized = dir.replace(/\\/g, '/');
  const absolute = normalized.replace(/^([A-Za-z]):\//, (_, drive: string) => {
    return `/${drive.toLowerCase()}/`;
  });
  return `/${absolute}/**`;
}

/**
 * The model of a run: the agent's own (`opsd.agents.<id>.model`, merged into `agent` by the
 * caller, or the role file's `model`), else the provider's. Checked here, because a role file's
 * value comes from a synced repo and must never read as a flag.
 */
export function runModel(rc: RuntimeConfig, agent: Pick<AgentDef, 'model' | 'file'> | undefined) {
  if (agent?.model !== undefined && agent.model !== null && agent.model !== '') {
    return checkModel(agent.model, `${agent.file || 'agent'}: model`);
  }
  return rc.model ? checkModel(rc.model, 'provider model') : undefined;
}

/**
 * Builds the arguments for one run. The prompt always goes on stdin, because Claude's
 * `--allowedTools` takes several values and would swallow a trailing prompt argument.
 * `readOnly` marks a run of a role that does not write (`roleLimits(...).writes` is false): a
 * Claude run gets no `Edit` or `Write`, even when its role file lists them, so a qa or reviewer
 * run never leaves changes in a shared checkout (AO-0136), and a Codex run starts in its task
 * store instead of `cwd`, with only the task stores writable (`stores`, its own first; AO-0138).
 * `storeCheckout` marks a run whose folder is a data root's checkout: a Claude run there gets
 * {@link STORE_CHECKOUT_DENY} (AO-0135).
 */
export function invocation(
  rc: RuntimeConfig,
  agentId: string,
  agent: AgentDef | undefined,
  cwd: string,
  addDirs: string[],
  roleDirs: string[] = [],
  chat?: ChatInvocation,
  readOnly = false,
  storeCheckout = false,
  stores: string[] = [],
): Invocation {
  const runtime = runtimeOf(agentId);
  const base = rc.args ?? [];
  const unsetEnv = rc.unset_env ?? [];
  const model = runModel(rc, agent);
  if (runtime === 'claude') {
    const own = agent?.tools ?? (chat ? CHAT_TOOLS : DEFAULT_CLAUDE_TOOLS);
    const denied = new Set([...(chat ? CHAT_DENY : []), ...(readOnly ? READ_ONLY_DENY : [])]);
    const tools = [...own.filter((t) => !denied.has(t)), 'Bash(ops *)'];
    const roleFileDeny = roleDirs.flatMap((dir) => {
      const pattern = claudeAbsolutePattern(dir);
      return [`Edit(${pattern})`, `Write(${pattern})`];
    });
    const session = chat
      ? [chat.resume ? '--resume' : '--session-id', chat.session, '--include-partial-messages']
      : [];
    return {
      args: [
        ...base,
        '-p',
        '--permission-mode',
        'acceptEdits',
        '--output-format',
        'stream-json',
        '--verbose',
        ...(model ? ['--model', model] : []),
        ...session,
        '--allowedTools',
        [...new Set(tools)].join(','),
        '--disallowedTools',
        [
          ...new Set([
            ...CLAUDE_DENY,
            ...(storeCheckout ? STORE_CHECKOUT_DENY : []),
            ...denied,
            ...roleFileDeny,
          ]),
        ].join(','),
        ...addDirs.flatMap((d) => ['--add-dir', d]),
      ],
      unsetEnv,
    };
  }
  if (runtime === 'codex') {
    const exec = (sandbox: string, cd: string, add: string[]) => [
      ...base,
      'exec',
      ...(model ? ['-m', model] : []),
      '--json',
      '--sandbox',
      sandbox,
      '--skip-git-repo-check',
      '-C',
      cd,
      ...add.flatMap((d) => ['--add-dir', d]),
      '-',
    ];
    if (!readOnly) return { args: exec('workspace-write', cwd, addDirs), unsetEnv };
    const dirs = codexReadOnlyDirs(stores);
    // With no task store to write, the run gets a read-only sandbox: its `ops` writes fail, but
    // the checkout stays as it was.
    if (!dirs) return { args: exec('read-only', cwd, []), unsetEnv };
    return {
      args: exec('workspace-write', dirs.cd, dirs.add),
      unsetEnv,
      note: readOnlyCodexNote(cwd, dirs.cd),
    };
  }
  // Other runtimes: the config's args are the whole command line.
  return { args: base, unsetEnv };
}

export interface PromptInput {
  agent: string;
  task?: string;
  /** Path of the role file, when the root defines the agent. */
  roleFile?: string;
  /** The role file's reading list and writing style, repeated in the prompt. */
  role?: Pick<AgentDef, 'kb' | 'files' | 'style'>;
  /** Extra instructions, such as a schedule's prompt. */
  extra?: string;
  /** The run reviews `task` instead of working it. */
  review?: boolean;
  /** `task` is a question to the agent: the run answers it instead of working it. */
  question?: QuestionPrompt;
  /**
   * The run's folder is the checkout of a data root (AO-0135): its branch carries the task store,
   * so the run makes code branches in worktrees. `branch` is the store branch, when known.
   */
  storeCheckout?: { top: string; branch?: string | null };
}

/** A question task, with the tasks and projects its text references. */
export interface QuestionPrompt {
  /** Who asked. */
  from: string;
  title: string;
  body: string;
  tasks: Array<{ ref: string; status: string; title: string }>;
  projects: string[];
  /**
   * Earlier rounds, oldest first: each answer, and each reply the asker reopened the question
   * with. A reply as the last round is what this run answers.
   */
  rounds?: Array<{ from: string; kind: 'answer' | 'reply'; text: string }>;
}

/** The task lines of a question run's prompt. */
function questionLines(task: string, q: QuestionPrompt): string[] {
  const lines = [
    '',
    `Answer the question ${task} from ${q.from}. It is a question, not work: read what you need,`,
    'but do not edit files, build, commit or push.',
    '',
    `Question: ${q.title}`,
  ];
  if (q.body && q.body !== q.title) lines.push(...q.body.split('\n').map((l) => `> ${l}`));
  const rounds = q.rounds ?? [];
  if (rounds.length > 0) {
    lines.push('', 'The conversation so far, oldest first:');
    for (const r of rounds) {
      lines.push(`- ${r.from} ${r.kind === 'answer' ? 'answered' : 'replied'}:`);
      lines.push(...r.text.split('\n').map((l) => `  > ${l}`));
    }
    if (rounds[rounds.length - 1]!.kind === 'reply') {
      lines.push('', 'Answer the latest reply; you need not repeat earlier answers.');
    }
  }
  if (q.tasks.length > 0) {
    lines.push('', 'Tasks it references (read them with `ops show <id>`):');
    for (const t of q.tasks) lines.push(`- ${t.ref} (${t.status}): ${t.title}`);
  }
  if (q.projects.length > 0) {
    lines.push(
      '',
      'Projects it references (list their tasks with `ops list --project <name>`):',
      ...q.projects.map((p) => `- ${p}`),
    );
  }
  lines.push(
    '',
    `Run \`ops start ${task}\` with a one-line plan, then finish with exactly one command:`,
    `- \`ops done ${task} "your answer"\`: the answer goes to ${q.from}'s inbox. Write it so it`,
    '  reads on its own: name the tasks, files and decisions it is about.',
    `- \`ops ask ${task} "one question"\` when only a person can answer a part of it.`,
    `- \`ops handoff ${task} <agent> "why"\` when another agent should answer it.`,
  );
  return lines;
}

/** One message a chat turn answers: from the person in the app, or a channel post. */
export interface ChatPromptMessage {
  from: string;
  text: string;
  /** The channel of a post that mentions the agent, without `#`. */
  channel?: string;
}

export interface ChatPromptInput {
  agent: string;
  /** The human the chat belongs to. */
  human: string;
  /** The first turn of a session gets the role and the rules; later turns a short reminder. */
  first: boolean;
  roleFile?: string;
  role?: Pick<AgentDef, 'kb' | 'files' | 'style'>;
  messages: ChatPromptMessage[];
}

/**
 * The prompt of one chat turn. The session carries the context between turns, so only the first
 * turn repeats the role and the rules in full.
 */
export function chatPrompt(p: ChatPromptInput): string {
  const lines: string[] = [];
  if (p.first) {
    lines.push(
      `You are ${p.agent} in Agent Ops v2, in a chat with ${p.human} in the desktop app. Use the`,
      'agent-ops skill; your id is in OPS_AGENT. Each message of the chat is one turn of this session.',
    );
    if (p.roleFile) lines.push(`Read your role file first: ${p.roleFile}`);
    if (p.role?.kb && p.role.kb.length > 0) {
      lines.push(
        `Read the learn notes of these topics: ${p.role.kb.map((t) => `\`ops kb --topic ${t}\``).join(', ')}.`,
      );
    }
    if (p.role?.files && p.role.files.length > 0) {
      lines.push(`Read these files: ${p.role.files.join(', ')}.`);
    }
    if (p.role?.style?.trim()) lines.push('Writing style:', p.role.style.trim());
    lines.push(
      '',
      'Chat rules:',
      `- ${p.human} brainstorms and adds work here. Answer briefly in Markdown; name tasks by id`,
      '  (AO-0123) so the app links them.',
      '- You may create tasks (`ops new`), comment, assign, retype, set priority, park, post in',
      "  channels, file findings and answer agents' asks. Say in your reply what you changed.",
      `- Never give a verdict, decide a vote, or answer an ask that waits for ${p.human}; never`,
      '  claim, start or work a task yourself: hand work to agents with `ops new --to` or',
      '  `ops assign`.',
      '- Do not edit files, build, commit or push.',
      '- Do not start background tasks, monitors or watchers; the turn ends when you stop.',
      '- Never kill a process; never print, store or export tokens or keys.',
    );
  } else {
    lines.push(
      `Next turn of the chat with ${p.human}. The chat rules of the first turn still hold: act only`,
      'through `ops`, no verdicts, no edits, say what you changed.',
    );
  }
  for (const m of p.messages) {
    lines.push('');
    if (m.channel) {
      lines.push(
        `${m.from} mentioned you in #${m.channel}. Answer there with`,
        `\`ops channel post ${m.channel} "..."\`, and sum up here what you answered:`,
      );
    } else {
      lines.push(`${m.from} writes:`);
    }
    lines.push('', m.text.trim());
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The rule for a run in a data root's checkout: a branch checked out there takes the task store
 * with it (AO-0133), so code branches live in worktrees inside the checkout, where the run may
 * edit.
 */
function storeCheckoutLines(co: { top: string; branch?: string | null }, task?: string): string[] {
  const top = co.top.replace(/\\/g, '/');
  const keep = co.branch ? `keep \`${co.branch}\` checked out` : 'keep its branch checked out';
  return [
    `- ${top} holds the task store: ${keep} and never run \`git checkout\` or`,
    '  `git switch` there. Make code branches in a worktree inside it, such as',
    `  \`git worktree add out/wt-${task ?? '<task id>'} -b <branch> <base>\` (\`--detach <commit>\` to look at`,
    '  one), and work in that folder with `git -C <folder>`; undo a file with `git restore`.',
  ];
}

/**
 * A custom prompt (`--prompt-file`, a helper's instructions, a chat turn) with the store-checkout
 * rule appended when the run's folder is a data root's checkout, so no launch path skips it.
 * Without `storeCheckout`, the prompt is returned unchanged.
 */
export function withStoreCheckoutRule(
  prompt: string,
  storeCheckout?: { top: string; branch?: string | null },
  task?: string,
): string {
  if (!storeCheckout) return prompt;
  const head = prompt.trimEnd();
  const rule = ['Rule for this folder:', ...storeCheckoutLines(storeCheckout, task)].join('\n');
  return `${head ? `${head}\n\n` : ''}${rule}\n`;
}

/** The standard prompt for a supervised run. */
export function runPrompt(p: PromptInput): string {
  const lines = [
    `You are ${p.agent} in Agent Ops v2. Use the agent-ops skill; your id is in OPS_AGENT.`,
  ];
  if (p.roleFile) lines.push(`Read your role file first: ${p.roleFile}`);
  if (p.role?.kb && p.role.kb.length > 0) {
    lines.push(
      `Read the learn notes of these topics before you work: ${p.role.kb.map((t) => `\`ops kb --topic ${t}\``).join(', ')}.`,
    );
  }
  if (p.role?.files && p.role.files.length > 0) {
    lines.push(`Read these files before you work: ${p.role.files.join(', ')}.`);
  }
  if (p.role?.style?.trim()) lines.push('Writing style:', p.role.style.trim());
  if (p.extra) {
    lines.push('', p.extra.trim());
  } else if (p.task && p.review) {
    lines.push(
      '',
      `Review ${p.task}: run \`ops show ${p.task}\` and check the work its review request names.`,
      'Do not edit, build, commit or push. Finish with exactly one verdict:',
      `\`ops verdict ${p.task} approve "why"\` or \`ops verdict ${p.task} changes "what to fix, file:line"\`.`,
    );
  } else if (p.task && p.question) {
    lines.push(...questionLines(p.task, p.question));
  } else if (p.task) {
    lines.push(
      '',
      `Work on ${p.task}: run \`ops show ${p.task}\`, then \`ops start ${p.task}\` with a one-line plan.`,
      'Finish it with exactly one finishing command (review, done, handoff, ask, block or release).',
    );
  } else {
    lines.push(
      '',
      'Run `ops inbox` and handle what waits for you, then `ops next` and work that task.',
    );
  }
  lines.push(
    '',
    'Rules for supervised runs:',
    '- Do not start background tasks, monitors or watchers; this run ends when you stop.',
    '- Never kill a process you did not start in this run, and only by the PID your own command',
    '  printed; never kill by name, user or start time.',
    '- Never print, store or export tokens or keys.',
    '- Every message to a person (ask, review, comment to human:*) names the task id, and',
    '  ID#<event id> or the date and author for a comment; says in one or two sentences what it',
    '  is about; and states the decision or action needed. Never "see the comment of <date>".',
  );
  if (p.storeCheckout) lines.push(...storeCheckoutLines(p.storeCheckout, p.task));
  // Review runs end with a verdict and write nothing, so the work rules would contradict it.
  if (!p.review) {
    lines.push(
      '- Decide technical and process choices yourself: pick the option you would recommend and',
      '  say why in your finishing command; the reviewer checks it. Ask a person only about money,',
      '  accounts, publishing, deleting data or the goal of the task.',
    );
    // A question run changes nothing, so the commit and push rule does not apply to it.
    if (!p.question) {
      lines.push(
        '- If you cannot commit, push or open a PR here (no GitHub sign-in, read-only .git), never',
        '  ask for access: finish with `ops review` naming the commit and branch, or the changed',
        '  files and where they are; the orchestrator commits and pushes.',
      );
    }
  }
  lines.push(`- Before you stop, run \`ops sync --session-end\` (agent ${actorSlug(p.agent)}).`);
  return `${lines.join('\n')}\n`;
}
