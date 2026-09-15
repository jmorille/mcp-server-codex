import type { Mailbox } from '../bridge/mailbox.ts';
import type { ServerConfig } from '../config.ts';
import type { CodexRunner } from '../codex/runner.ts';
import type { JobStore } from '../jobs/store.ts';
import type { PathPolicy } from '../security/paths.ts';

/**
 * Everything a tool handler is allowed to touch.
 *
 * Passing this explicitly — rather than reaching for module-level singletons —
 * is what lets the whole tool layer be exercised against a stub runner and a
 * throwaway workspace.
 */
export interface ToolContext {
  config: ServerConfig;
  runner: CodexRunner;
  jobs: JobStore;
  paths: PathPolicy;
  /** The Claude end of the two-way bridge. Always present: the bridge is not opt-in. */
  bridge: Mailbox;
}
