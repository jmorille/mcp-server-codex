import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../../src/config.ts';
import type { Env } from '../../src/config.ts';
import { createPathPolicy } from '../../src/security/paths.ts';
import { createJobStore } from '../../src/jobs/store.ts';
import type { ToolContext } from '../../src/tools/types.ts';
import { createStubRunner } from './stub-runner.ts';
import type { StubRunner } from './stub-runner.ts';

export interface TestContext extends ToolContext {
  runner: StubRunner;
  /** A real directory inside the allowlist, for cwd and output paths. */
  workspace: string;
  cleanup(): void;
}

/**
 * Build a tool context wired to a stub runner and a throwaway workspace that
 * is the only allowed root, so allowlist violations are easy to provoke.
 */
export function createTestContext(env: Env = {}): TestContext {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-codex-ws-')));
  const codexHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-codex-home-')));

  const config = loadConfig(
    { CODEX_MCP_ALLOWED_ROOTS: workspace, CODEX_HOME: codexHome, ...env },
    workspace,
  );
  const runner = createStubRunner();

  return {
    config,
    runner,
    jobs: createJobStore({ maxEvents: config.maxEvents, ttlMs: config.jobTtlMs }),
    paths: createPathPolicy(config.allowedRoots),
    workspace,
    cleanup() {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
    },
  };
}

/** Run a tool call that is expected to finish inline, settling the stub for it. */
export async function completeWith<T>(
  runner: StubRunner,
  call: Promise<T>,
  emit: (r: StubRunner) => void = () => {},
): Promise<T> {
  await runner.started();
  emit(runner);
  runner.settle();
  return call;
}
