import { buildForkArgs, buildResumeArgs } from '../codex/argv.ts';
import { listSessions } from '../codex/sessions.ts';
import type { SessionInfo } from '../codex/sessions.ts';
import { runHybrid } from '../jobs/hybrid.ts';
import type { HybridOutcome } from '../jobs/hybrid.ts';
import { resolveCommon } from './common.ts';
import type { CommonToolInput } from './common.ts';
import type { ToolContext } from './types.ts';

export interface ResumeToolInput extends CommonToolInput {
  session_id?: string;
  last?: boolean;
  prompt?: string;
}

export interface ForkToolInput extends CommonToolInput {
  session_id: string;
  prompt?: string;
}

export interface ListSessionsToolInput {
  limit?: number;
  cwd?: string;
  query?: string;
}

/** Continue an existing Codex session, keeping its full history. */
export async function resumeTool(context: ToolContext, input: ResumeToolInput): Promise<HybridOutcome> {
  const common = resolveCommon(context, input);

  const args = buildResumeArgs({
    sessionId: input.session_id,
    last: input.last,
    prompt: input.prompt,
    sandbox: common.sandbox,
    model: input.model,
    images: common.images,
    config: input.config,
    enable: input.enable,
    disable: input.disable,
    outputSchema: common.outputSchema,
    worktree: input.worktree,
    ephemeral: input.ephemeral,
    skipGitRepoCheck: input.skip_git_repo_check,
    dangerouslyBypassApprovalsAndSandbox: input.dangerously_bypass_approvals_and_sandbox,
  });

  return runHybrid(context, {
    tool: 'codex_resume',
    args,
    stdin: input.prompt,
    cwd: common.cwd,
    timeoutMs: common.timeoutMs,
  });
}

/** Branch an existing session into a new one, leaving the original untouched. */
export async function forkTool(context: ToolContext, input: ForkToolInput): Promise<HybridOutcome> {
  const common = resolveCommon(context, input);

  const args = buildForkArgs({
    sessionId: input.session_id,
    prompt: input.prompt,
    sandbox: common.sandbox,
    model: input.model,
    images: common.images,
    config: input.config,
    enable: input.enable,
    disable: input.disable,
    outputSchema: common.outputSchema,
    worktree: input.worktree,
    ephemeral: input.ephemeral,
    skipGitRepoCheck: input.skip_git_repo_check,
    dangerouslyBypassApprovalsAndSandbox: input.dangerously_bypass_approvals_and_sandbox,
  });

  return runHybrid(context, {
    tool: 'codex_fork',
    args,
    stdin: input.prompt,
    cwd: common.cwd,
    timeoutMs: common.timeoutMs,
  });
}

/**
 * List recorded sessions straight from disk.
 *
 * No process is spawned: `codex resume` without an id opens an interactive
 * picker, which an MCP server can never drive.
 */
export async function listSessionsTool(
  context: ToolContext,
  input: ListSessionsToolInput,
): Promise<{ sessions: SessionInfo[] }> {
  const sessions = await listSessions({
    codexHome: context.config.codexHome,
    limit: input.limit ?? 20,
    cwd: input.cwd,
    query: input.query,
  });
  return { sessions };
}
