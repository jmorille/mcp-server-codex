import { buildExecArgs } from '../codex/argv.ts';
import { runHybrid } from '../jobs/hybrid.ts';
import type { HybridOutcome } from '../jobs/hybrid.ts';
import { resolveCommon } from './common.ts';
import type { CommonToolInput } from './common.ts';
import type { ToolContext } from './types.ts';

export interface ExecToolInput extends CommonToolInput {
  prompt: string;
  profile?: string;
  add_dir?: string[];
}

/** Start a fresh Codex session against a prompt. */
export async function execTool(context: ToolContext, input: ExecToolInput): Promise<HybridOutcome> {
  const common = resolveCommon(context, input);
  const addDirs = input.add_dir?.map((dir) => context.paths.resolve(dir));

  const args = buildExecArgs({
    prompt: input.prompt,
    sandbox: common.sandbox,
    model: input.model,
    profile: input.profile,
    addDirs,
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
    tool: 'codex_exec',
    args,
    stdin: input.prompt,
    cwd: common.cwd,
    timeoutMs: common.timeoutMs,
  });
}
