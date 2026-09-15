/**
 * Zod shapes for the tool inputs.
 *
 * These are what the MCP client sees, so the `.describe()` text is not a
 * comment — it is the documentation the calling agent reads when deciding how
 * to invoke a tool. Vague descriptions here produce wrong calls.
 */

import { z } from 'zod';

export const sandboxSchema = z
  .enum(['read-only', 'workspace-write', 'danger-full-access'])
  .describe(
    'Sandbox for commands Codex runs. "read-only" forbids writes, "workspace-write" (default) ' +
      'allows writes inside the workspace, "danger-full-access" removes all limits and is ' +
      'refused unless the server was started with CODEX_MCP_ALLOW_DANGEROUS=1.',
  );

/** Fields shared by every tool that starts a Codex run. */
export const commonRunShape = {
  cwd: z
    .string()
    .optional()
    .describe('Working directory for the run. Must sit inside the server allowlist. Defaults to the first allowed root.'),
  model: z.string().optional().describe('Model slug, e.g. "gpt-5.5". Defaults to the Codex configuration.'),
  sandbox: sandboxSchema.optional(),
  images: z.array(z.string()).optional().describe('Image files to attach to the prompt. Each must be inside the allowlist.'),
  config: z
    .array(z.string())
    .optional()
    .describe('Raw Codex config overrides as key=value, TOML-parsed, e.g. \'model_reasoning_effort="high"\'.'),
  enable: z.array(z.string()).optional().describe('Codex feature flags to enable for this run.'),
  disable: z.array(z.string()).optional().describe('Codex feature flags to disable for this run.'),
  output_schema: z
    .string()
    .optional()
    .describe('Path to a JSON Schema file constraining the shape of the agent final response.'),
  worktree: z.boolean().optional().describe('Run in a fresh managed git worktree instead of the working directory.'),
  ephemeral: z.boolean().optional().describe('Do not persist the session to disk. It cannot be resumed afterwards.'),
  skip_git_repo_check: z.boolean().optional().describe('Allow running outside a git repository.'),
  dangerously_bypass_approvals_and_sandbox: z
    .boolean()
    .optional()
    .describe('Remove every approval and sandbox check. Refused unless CODEX_MCP_ALLOW_DANGEROUS=1.'),
  timeout_seconds: z
    .number()
    .min(0)
    .optional()
    .describe(
      'How long to wait inline before handing back a job_id and continuing in the background. ' +
        '0 means return immediately. Defaults to the server setting (120s).',
    ),
};

export const execShape = {
  prompt: z.string().min(1).describe('Instructions for the Codex agent. Sent over stdin, so length is unconstrained.'),
  profile: z.string().optional().describe('Codex config profile to layer on top of the base configuration.'),
  add_dir: z
    .array(z.string())
    .optional()
    .describe('Extra directories Codex may write to, beyond the working directory. Each must be inside the allowlist.'),
  ...commonRunShape,
};

export const resumeShape = {
  session_id: z.string().optional().describe('Session UUID or thread name to continue. Mutually exclusive with "last".'),
  // codex_exec reports the same value as thread_id; accepting both names lets a
  // caller feed one tool's output straight into the next.
  thread_id: z.string().optional().describe('Alias for session_id, matching the thread_id returned by codex_exec.'),
  last: z.boolean().optional().describe('Continue the most recent recorded session. Mutually exclusive with "session_id".'),
  prompt: z.string().optional().describe('Message to send after resuming. Omit to just replay the session.'),
  ...commonRunShape,
};

export const forkShape = {
  session_id: z.string().optional().describe('Session UUID or thread name to branch from. The original is left untouched.'),
  thread_id: z.string().optional().describe('Alias for session_id, matching the thread_id returned by codex_exec.'),
  prompt: z.string().optional().describe('Message to send in the forked session.'),
  ...commonRunShape,
};

export const reviewShape = {
  prompt: z.string().optional().describe('Custom review instructions, e.g. "focus on race conditions".'),
  uncommitted: z.boolean().optional().describe('Review staged, unstaged and untracked changes. This is the default.'),
  base: z.string().optional().describe('Review the diff against this base branch.'),
  commit: z.string().optional().describe('Review the changes introduced by this commit SHA.'),
  title: z.string().optional().describe('Title shown in the review summary.'),
  ...commonRunShape,
};

export const applyShape = {
  task_id: z.string().min(1).describe('Codex task id whose latest diff should be applied with git apply.'),
  cwd: z.string().optional().describe('Repository to apply into. Must sit inside the server allowlist.'),
  timeout_seconds: z.number().min(0).optional().describe('Inline wait before backgrounding. 0 returns immediately.'),
};

export const listSessionsShape = {
  limit: z.number().int().min(1).max(200).optional().describe('Maximum number of sessions to return. Defaults to 20.'),
  cwd: z.string().optional().describe('Only sessions whose working directory matches this path.'),
  query: z.string().optional().describe('Case-insensitive substring match on the thread name or id.'),
};

export const generateImageShape = {
  preset: z
    .string()
    .optional()
    .describe(
      'Named preset configured on this server instance. It supplies the subject, style, constraints ' +
        'and reference art, so the prompt only has to say what differs. The tool description lists ' +
        'the presets this instance knows; omit it on an instance that has none.',
    ),
  prompt: z
    .string()
    .min(1)
    .describe(
      'What the image should show. Plain language; the server wraps it in the spec Codex expects. ' +
        'With a preset, describe only the variation — the preset already carries the subject.',
    ),
  output_path: z
    .string()
    .min(1)
    .describe('Where to write the image, e.g. "assets/hero.png". Must sit inside the server allowlist.'),
  use_case: z
    .string()
    .optional()
    .describe(
      'Taxonomy slug steering the style: product-mockup, ui-mockup, logo-brand, illustration-story, ' +
        'infographic-diagram, photorealistic-natural, stylized-concept, ads-marketing.',
    ),
  size: z.string().optional().describe('Requested size, e.g. "1024x1024", "1536x1024", "3840x2160".'),
  transparent: z.boolean().optional().describe('Ask for a genuinely transparent background and preserve the alpha channel.'),
  style: z.string().optional().describe('Style or medium, e.g. "flat minimal vector", "studio product photography".'),
  constraints: z.string().optional().describe('Things the image must avoid or preserve, e.g. "no text, no watermark".'),
  reference_images: z
    .array(z.string())
    .optional()
    .describe('Reference images for style or composition. Each must be inside the allowlist.'),
  ...commonRunShape,
};

export const jobStatusShape = {
  job_id: z.string().min(1).describe('Job id returned by a tool call that went to the background.'),
};

export const jobLogsShape = {
  job_id: z.string().min(1).describe('Job id returned by a tool call that went to the background.'),
  since: z.number().int().min(0).optional().describe('Cursor from a previous call. Omit to read from the start.'),
  types: z
    .array(z.string())
    .optional()
    .describe('Keep only these event types, e.g. ["item.completed", "turn.completed"].'),
  limit: z.number().int().min(1).max(1000).optional().describe('Maximum events per page. Defaults to 200.'),
};

export const jobCancelShape = {
  job_id: z.string().min(1).describe('Job id to cancel. Sends SIGTERM, then SIGKILL after a grace period.'),
};

export const inboxShape = {
  since: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('next_cursor from a previous call. Omit to read everything Codex has sent.'),
  job_id: z.string().optional().describe('Only messages from this run. Omit to watch every run at once.'),
};

export const replyShape = {
  message_id: z.string().min(1).describe('Id of the Codex message being answered, from codex_inbox.'),
  text: z.string().min(1).describe('The answer. Codex is blocked waiting for it, so be direct.'),
};

export const tellShape = {
  message: z.string().min(1).describe('What to tell Codex. It reads this at its next tool turn.'),
  job_id: z
    .string()
    .optional()
    .describe('Only tell this run. Omit to reach every run, which is what you want for "stop".'),
};

export const presetListShape = {};

export const presetReloadShape = {};

export const presetSetShape = {
  name: z.string().min(1).describe('Name callers will pass as "preset". Replaces an existing preset of the same name.'),
  subject: z
    .string()
    .optional()
    .describe('The recurring subject, prepended to every prompt using this preset. This is the field that earns a preset.'),
  style: z.string().optional().describe('Style or medium, e.g. "pixel art 16-bit, limited palette".'),
  constraints: z.string().optional().describe('What images from this preset must avoid, e.g. "no watermark".'),
  use_case: z.string().optional().describe('Taxonomy slug steering the rendering, e.g. "stylized-concept".'),
  size: z.string().optional().describe('Default size, e.g. "1024x1024".'),
  transparent: z.boolean().optional().describe('Ask for a transparent background by default.'),
  reference_images: z
    .array(z.string())
    .optional()
    .describe('Reference art for this subject. Each must sit inside the server allowlist.'),
};
