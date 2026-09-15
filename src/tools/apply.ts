import { buildApplyArgs } from '../codex/argv.ts';
import { runHybrid } from '../jobs/hybrid.ts';
import type { HybridOutcome } from '../jobs/hybrid.ts';
import type { ToolContext } from './types.ts';

export interface ApplyToolInput {
  task_id: string;
  cwd?: string;
  timeout_seconds?: number;
}

/**
 * Apply the latest diff a Codex task produced, as a `git apply` in the working
 * tree. Writes to the repository, so the working directory still goes through
 * the allowlist even though no sandbox flag applies here.
 */
export async function applyTool(context: ToolContext, input: ApplyToolInput): Promise<HybridOutcome> {
  const cwd = input.cwd ? context.paths.resolve(input.cwd) : (context.config.allowedRoots[0] as string);
  const timeoutMs =
    input.timeout_seconds !== undefined
      ? Math.round(input.timeout_seconds * 1_000)
      : context.config.defaultTimeoutMs;

  return runHybrid(context, {
    tool: 'codex_apply',
    args: buildApplyArgs({ taskId: input.task_id }),
    cwd,
    timeoutMs,
  });
}
