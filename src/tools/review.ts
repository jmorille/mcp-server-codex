import { buildReviewArgs } from '../codex/argv.ts';
import { runHybrid } from '../jobs/hybrid.ts';
import type { HybridOutcome } from '../jobs/hybrid.ts';
import { resolveCommon } from './common.ts';
import type { CommonToolInput } from './common.ts';
import type { ToolContext } from './types.ts';

export interface ReviewToolInput extends CommonToolInput {
  prompt?: string;
  uncommitted?: boolean;
  base?: string;
  commit?: string;
  title?: string;
}

/**
 * Run a Codex code review.
 *
 * This goes through `codex exec review`, not the top-level `codex review`:
 * only the former supports `--json`, and a review whose output we cannot parse
 * is of no use to a calling agent.
 */
export async function reviewTool(context: ToolContext, input: ReviewToolInput): Promise<HybridOutcome> {
  const common = resolveCommon(context, input);

  // With no target at all Codex would pick its own default; being explicit
  // keeps the tool's behaviour predictable across Codex versions.
  const hasTarget = input.uncommitted === true || input.base !== undefined || input.commit !== undefined;

  const args = buildReviewArgs({
    prompt: input.prompt,
    uncommitted: hasTarget ? input.uncommitted : true,
    base: input.base,
    commit: input.commit,
    title: input.title,
    sandbox: common.sandbox,
    model: input.model,
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
    tool: 'codex_review',
    args,
    stdin: input.prompt,
    cwd: common.cwd,
    timeoutMs: common.timeoutMs,
  });
}
