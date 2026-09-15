/**
 * Runs a single hybrid call and nothing else.
 *
 * The point is what is *absent*: no test runner, no server, no child process —
 * so the race timer is the only thing that can keep the event loop alive. If it
 * is created with .unref(), Node exits before the call resolves and this script
 * prints nothing, which is exactly the failure Node 22 reported as
 * "Promise resolution is still pending but the event loop has already resolved".
 */

import { runHybrid } from '../../src/jobs/hybrid.ts';
import { createJobStore } from '../../src/jobs/store.ts';

/** A runner whose run never settles on its own. */
const neverSettles = {
  run: () => new Promise(() => {}),
  version: async () => 'codex-cli 0.0.0-test',
};

const outcome = await runHybrid(
  { runner: neverSettles, jobs: createJobStore() },
  { tool: 'codex_exec', args: ['exec'], timeoutMs: 300 },
);

process.stdout.write(`resolved:${outcome.mode}\n`);
process.exit(0);
