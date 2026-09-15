/**
 * Composition root.
 *
 * Builds the object graph the tools run against and owns the two pieces of
 * process-level lifecycle: the periodic reaping of finished jobs, and stopping
 * every live child when the server goes down.
 *
 * Kept separate from `index.ts` so it can be constructed in a test without a
 * transport, a real binary, or a process to shut down.
 */

import { loadConfig } from './config.ts';
import type { Env, ServerConfig } from './config.ts';
import { createCodexRunner } from './codex/runner.ts';
import { createJobStore } from './jobs/store.ts';
import { createPathPolicy } from './security/paths.ts';
import type { ToolContext } from './tools/types.ts';

export interface Runtime {
  context: ToolContext;
  config: ServerConfig;
  /** Stop the sweeper and cancel anything still running. Idempotent. */
  dispose(): void;
}

/** How often finished jobs are swept out of the store. */
const SWEEP_INTERVAL_MS = 60_000;

export function createRuntime(env: Env, cwd: string): Runtime {
  // A bad value throws here, before any transport is connected: better to
  // refuse to start than to run under a policy the operator did not ask for.
  const config = loadConfig(env, cwd);

  const jobs = createJobStore({ maxEvents: config.maxEvents, ttlMs: config.jobTtlMs });
  const context: ToolContext = {
    config,
    runner: createCodexRunner({ binary: config.binary }),
    jobs,
    paths: createPathPolicy(config.allowedRoots),
  };

  const sweeper = setInterval(() => jobs.sweep(), SWEEP_INTERVAL_MS);
  // The sweeper must never be the reason the process stays alive.
  sweeper.unref?.();

  let disposed = false;

  return {
    context,
    config,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearInterval(sweeper);
      jobs.cancelAll();
    },
  };
}
