/**
 * Shared plumbing between the run-style tools.
 *
 * Every tool that spawns Codex performs the same four steps before the process
 * starts: validate paths against the allowlist, check the sandbox against the
 * server policy, pick a timeout, and decide the working directory. Keeping that
 * in one place is what makes "the guardrails apply everywhere" a property of
 * the design rather than a thing to remember per tool.
 */

import { BRIDGE_THREAD_ENV, bridgeOverrides } from '../bridge/wiring.ts';
import { assertBypassAllowed, assertSandboxAllowed } from '../config.ts';
import { assertConfigOverridesAllowed } from '../security/config-keys.ts';
import type { SandboxMode } from '../codex/argv.ts';
import type { HybridOutcome } from '../jobs/hybrid.ts';
import type { ToolContext } from './types.ts';

/** Fields every run-style tool accepts. */
export interface CommonToolInput {
  cwd?: string;
  model?: string;
  sandbox?: SandboxMode;
  images?: string[];
  config?: string[];
  enable?: string[];
  disable?: string[];
  output_schema?: string;
  worktree?: boolean;
  ephemeral?: boolean;
  skip_git_repo_check?: boolean;
  dangerously_bypass_approvals_and_sandbox?: boolean;
  timeout_seconds?: number;
}

export interface ResolvedCommon {
  cwd: string;
  sandbox: SandboxMode;
  timeoutMs: number;
  images: string[] | undefined;
  outputSchema: string | undefined;
}

/**
 * The `-c` overrides that attach the bridge to one run.
 *
 * Handed to `runHybrid` rather than inlined into the argv because the bridge
 * has to be told which run it serves, and that identity is the job id, which
 * does not exist until the job is created. Applied by every run-style tool, so
 * the bridge is a property of the server rather than something a caller can
 * forget to ask for.
 */
export function bridgeArgsFor(context: ToolContext): (jobId: string) => string[] {
  return (jobId) =>
    bridgeOverrides({
      mailboxDir: context.config.bridgeDir,
      command: context.config.bridgeCommand,
      args: [context.config.bridgeEntry],
      env: {
        [BRIDGE_THREAD_ENV]: jobId,
        CODEX_BRIDGE_TIMEOUT_SECONDS: String(Math.round(context.config.bridgeTimeoutMs / 1_000)),
      },
    });
}

/**
 * Validate the parts of a tool call that can reject it, before anything is
 * spawned. Throws `PathViolationError` or `ConfigError`, both of which carry a
 * message an agent can act on.
 */
export function resolveCommon(context: ToolContext, input: CommonToolInput): ResolvedCommon {
  const sandbox = input.sandbox ?? context.config.defaultSandbox;
  assertSandboxAllowed(sandbox, context.config);
  assertBypassAllowed(input.dangerously_bypass_approvals_and_sandbox === true, context.config);
  // Checked with the other two, because a `-c` override can reach past both of
  // them: the sandbox level means nothing if the caller can also set it.
  assertConfigOverridesAllowed(input.config, context.config);

  // Resolve every caller-supplied path through the allowlist. A rejection here
  // happens before the process exists, so a refused call has no side effects.
  const cwd = input.cwd ? context.paths.resolve(input.cwd) : (context.config.allowedRoots[0] as string);
  const images = input.images?.map((image) => context.paths.resolve(image));
  const outputSchema = input.output_schema ? context.paths.resolve(input.output_schema) : undefined;

  return {
    cwd,
    sandbox,
    timeoutMs:
      input.timeout_seconds !== undefined
        ? Math.round(input.timeout_seconds * 1_000)
        : context.config.defaultTimeoutMs,
    images,
    outputSchema,
  };
}

/** A one-line, human-readable recap for the text part of a tool result. */
export function describeOutcome(outcome: HybridOutcome): string {
  if (outcome.mode === 'background') {
    return (
      `Codex is still running after ${Math.round(outcome.durationMs / 1000)}s; it was moved to the background.\n` +
      `job_id: ${outcome.jobId}\n` +
      (outcome.threadId ? `thread_id: ${outcome.threadId}\n` : '') +
      'Poll codex_job_status or codex_job_logs with this job_id.'
    );
  }

  const header =
    outcome.status === 'completed'
      ? `Codex finished in ${Math.round(outcome.durationMs / 1000)}s.`
      : `Codex ${outcome.status} after ${Math.round(outcome.durationMs / 1000)}s (exit code ${outcome.exitCode}).`;

  const parts = [header];
  if (outcome.threadId) parts.push(`thread_id: ${outcome.threadId}`);
  if (outcome.commands.length > 0) parts.push(`${outcome.commands.length} command(s) executed.`);
  if (outcome.errors.length > 0) parts.push(`Errors: ${outcome.errors.join('; ')}`);
  if (outcome.finalMessage) parts.push('', outcome.finalMessage);
  else if (outcome.stderr.trim() !== '') parts.push('', outcome.stderr.trim());

  return parts.join('\n');
}
