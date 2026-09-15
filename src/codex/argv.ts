/**
 * Pure argv builders for the Codex CLI.
 *
 * Kept free of I/O so the exact command line is cheap to assert in tests --
 * this is the module where a wrong flag turns into a silently wrong run.
 *
 * Three facts about Codex 0.154 drive the shape of this file:
 *
 * - Only `codex exec` accepts `-s/--sandbox`, `-C/--cd`, `--add-dir` and
 *   `-p/--profile`. `exec resume`, `exec fork` and `exec review` do not, so the
 *   sandbox is routed through `-c sandbox_mode=...` for those.
 * - The top-level `codex review` has no `--json`; `codex exec review` does.
 *   Every review therefore goes through `exec review`.
 * - The prompt is always passed as `-`, meaning "read from stdin". That keeps
 *   arbitrarily long prompts off a command line capped at 8191 characters on
 *   Windows, and sidesteps shell quoting entirely.
 */

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ApprovalPolicy = 'never' | 'on-request';

export class ArgvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgvError';
  }
}

/** Options every Codex subcommand understands. */
interface CommonOptions {
  model?: string;
  config?: string[];
  enable?: string[];
  disable?: string[];
  outputSchema?: string;
  outputLastMessage?: string;
  images?: string[];
  worktree?: boolean;
  ephemeral?: boolean;
  skipGitRepoCheck?: boolean;
  approvalPolicy?: ApprovalPolicy;
  dangerouslyBypassApprovalsAndSandbox?: boolean;
}

export interface ExecOptions extends CommonOptions {
  prompt: string;
  sandbox?: SandboxMode;
  profile?: string;
  addDirs?: string[];
}

export interface ResumeOptions extends CommonOptions {
  sessionId?: string;
  last?: boolean;
  prompt?: string;
  sandbox?: SandboxMode;
}

export interface ForkOptions extends CommonOptions {
  sessionId: string;
  prompt?: string;
  sandbox?: SandboxMode;
}

export interface ReviewOptions extends CommonOptions {
  prompt?: string;
  uncommitted?: boolean;
  base?: string;
  commit?: string;
  title?: string;
  sandbox?: SandboxMode;
}

export interface ApplyOptions {
  taskId: string;
}

const DEFAULT_SANDBOX: SandboxMode = 'workspace-write';
const DEFAULT_APPROVAL: ApprovalPolicy = 'never';

/** `-c` values are parsed as TOML by Codex, so strings need their quotes. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

function repeated(flag: string, values: string[] | undefined): string[] {
  if (!values) return [];
  return values.flatMap((value) => [flag, value]);
}

/**
 * Flags shared by every subcommand, in a fixed order so the produced argv is
 * deterministic and directly assertable.
 *
 * There is no human on the other end of an MCP call, so approvals default to
 * `never`: a denied command comes back to the model as a failure it can reason
 * about, instead of hanging the run forever.
 */
function commonFlags(options: CommonOptions): string[] {
  const args: string[] = [];
  args.push('-c', `approval_policy=${tomlString(options.approvalPolicy ?? DEFAULT_APPROVAL)}`);
  for (const pair of options.config ?? []) args.push('-c', pair);
  return args;
}

function commonTail(options: CommonOptions): string[] {
  const args: string[] = [];

  if (options.model) args.push('-m', options.model);
  args.push(...repeated('-i', options.images));
  args.push(...repeated('--enable', options.enable));
  args.push(...repeated('--disable', options.disable));
  if (options.outputSchema) args.push('--output-schema', options.outputSchema);
  if (options.outputLastMessage) args.push('-o', options.outputLastMessage);
  if (options.worktree) args.push('--worktree');
  if (options.ephemeral) args.push('--ephemeral');
  if (options.skipGitRepoCheck) args.push('--skip-git-repo-check');
  if (options.dangerouslyBypassApprovalsAndSandbox) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }

  return args;
}

export function buildExecArgs(options: ExecOptions): string[] {
  if (options.prompt.trim() === '') {
    throw new ArgvError('An exec prompt cannot be empty.');
  }

  const args = ['exec', '--json', ...commonFlags(options)];

  args.push('-s', options.sandbox ?? DEFAULT_SANDBOX);
  if (options.model) args.push('-m', options.model);
  if (options.profile) args.push('-p', options.profile);
  args.push(...repeated('--add-dir', options.addDirs));
  args.push(...repeated('-i', options.images));
  args.push(...repeated('--enable', options.enable));
  args.push(...repeated('--disable', options.disable));
  if (options.outputSchema) args.push('--output-schema', options.outputSchema);
  if (options.outputLastMessage) args.push('-o', options.outputLastMessage);
  if (options.worktree) args.push('--worktree');
  if (options.ephemeral) args.push('--ephemeral');
  if (options.skipGitRepoCheck) args.push('--skip-git-repo-check');
  if (options.dangerouslyBypassApprovalsAndSandbox) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }

  args.push('-');
  return args;
}

/** `exec resume|fork|review` have no `-s`, so the sandbox rides on `-c`. */
function sandboxViaConfig(sandbox: SandboxMode | undefined): string[] {
  return ['-c', `sandbox_mode=${tomlString(sandbox ?? DEFAULT_SANDBOX)}`];
}

export function buildResumeArgs(options: ResumeOptions): string[] {
  const hasId = Boolean(options.sessionId && options.sessionId.trim() !== '');
  if (hasId && options.last) {
    throw new ArgvError('Pass either session_id or last, not both.');
  }
  if (!hasId && !options.last) {
    throw new ArgvError('Resuming requires either a session_id or last=true.');
  }

  const args = [
    'exec',
    'resume',
    '--json',
    ...commonFlags(options),
    ...sandboxViaConfig(options.sandbox),
    ...commonTail(options),
  ];

  if (options.last) args.push('--last');
  else args.push(options.sessionId as string);

  if (options.prompt && options.prompt.trim() !== '') args.push('-');
  return args;
}

export function buildForkArgs(options: ForkOptions): string[] {
  if (!options.sessionId || options.sessionId.trim() === '') {
    throw new ArgvError('Forking requires a session_id.');
  }

  const args = [
    'exec',
    'fork',
    '--json',
    ...commonFlags(options),
    ...sandboxViaConfig(options.sandbox),
    ...commonTail(options),
    options.sessionId,
  ];

  if (options.prompt && options.prompt.trim() !== '') args.push('-');
  return args;
}

export function buildReviewArgs(options: ReviewOptions): string[] {
  const targets = [
    options.uncommitted === true,
    options.base !== undefined,
    options.commit !== undefined,
  ];
  const targetCount = targets.filter(Boolean).length;
  const hasPrompt = options.prompt !== undefined && options.prompt.trim() !== '';

  if (targetCount > 1) {
    throw new ArgvError('Pick a single review target: uncommitted, base or commit.');
  }
  // `codex exec review` declares PROMPT and the target flags mutually
  // exclusive — "the argument '--uncommitted' cannot be used with '[PROMPT]'".
  // Emitting both makes the process die at exit code 2 before any review runs.
  if (hasPrompt && targetCount > 0) {
    throw new ArgvError(
      'Custom review instructions cannot be combined with a target: codex exec review accepts ' +
        'either a prompt or one of uncommitted/base/commit, never both. ' +
        'Drop the target to review with instructions, or drop the prompt to review a specific target.',
    );
  }

  const args = [
    'exec',
    'review',
    '--json',
    ...commonFlags(options),
    ...sandboxViaConfig(options.sandbox),
    ...commonTail(options),
  ];

  if (options.title) args.push('--title', options.title);
  if (options.uncommitted) args.push('--uncommitted');
  if (options.base !== undefined) args.push('--base', options.base);
  if (options.commit !== undefined) args.push('--commit', options.commit);

  if (options.prompt && options.prompt.trim() !== '') args.push('-');
  return args;
}

export function buildApplyArgs(options: ApplyOptions): string[] {
  if (!options.taskId || options.taskId.trim() === '') {
    throw new ArgvError('Applying a diff requires a task_id.');
  }
  return ['apply', options.taskId];
}
