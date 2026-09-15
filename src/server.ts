/**
 * MCP wiring.
 *
 * Deliberately thin: every tool handler here validates, delegates to the
 * matching module in `tools/`, and shapes the reply. All the behaviour worth
 * testing lives one layer down, where it can be exercised without a transport.
 *
 * Each reply carries two views of the same result — readable text for the model
 * and `structuredContent` for programmatic use. No `outputSchema` is declared:
 * the SDK would then validate every reply against it, and a Codex upgrade that
 * adds a field would start failing calls that actually succeeded.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { describeOutcome } from './tools/common.ts';
import { execTool } from './tools/exec.ts';
import { resumeTool, forkTool, listSessionsTool } from './tools/sessions.ts';
import { reviewTool } from './tools/review.ts';
import { applyTool } from './tools/apply.ts';
import { generateImageTool } from './tools/image.ts';
import { jobStatusTool, jobLogsTool, jobCancelTool } from './tools/jobs.ts';
import type { ToolContext } from './tools/types.ts';
import type { HybridOutcome } from './jobs/hybrid.ts';
import {
  applyShape,
  execShape,
  forkShape,
  generateImageShape,
  jobCancelShape,
  jobLogsShape,
  jobStatusShape,
  listSessionsShape,
  resumeShape,
  reviewShape,
} from './schemas.ts';

export const SERVER_NAME = 'mcp-server-codex';
export const SERVER_VERSION = '0.1.0';

function ok(text: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

/**
 * Turn a thrown guardrail or validation error into a tool error.
 *
 * Tool errors come back to the model rather than to the transport, which is
 * what lets an agent read "that path is outside the allowlist" and retry with a
 * correct one instead of seeing an opaque protocol failure.
 */
function fail(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function guard(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    return fail(error);
  }
}

/** Flatten a run outcome into the snake_case shape tool consumers expect. */
function outcomePayload(outcome: HybridOutcome): Record<string, unknown> {
  return {
    job_id: outcome.jobId,
    mode: outcome.mode,
    status: outcome.status,
    thread_id: outcome.threadId,
    final_message: outcome.finalMessage,
    messages: outcome.messages,
    commands: outcome.commands,
    usage: outcome.usage,
    errors: outcome.errors,
    exit_code: outcome.exitCode,
    stderr: outcome.stderr,
    aborted: outcome.aborted,
    duration_ms: outcome.durationMs,
    event_count: outcome.eventCount,
  };
}

const WRITES = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
const READS = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

export function createServer(context: ToolContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    'codex_exec',
    {
      title: 'Run Codex',
      description:
        'Start a new Codex agent session against a prompt. Codex can read and edit files and run ' +
        'commands in the sandbox. Returns the final message, the commands it ran and a thread_id ' +
        'you can pass to codex_resume. Long runs move to the background and return a job_id.',
      inputSchema: execShape,
      annotations: WRITES,
    },
    async (input) =>
      guard(async () => {
        const outcome = await execTool(context, input);
        return ok(describeOutcome(outcome), outcomePayload(outcome));
      }),
  );

  server.registerTool(
    'codex_resume',
    {
      title: 'Resume a Codex session',
      description:
        'Continue a previous Codex session with its full history, either by session_id or with ' +
        'last=true for the most recent one. Use this instead of codex_exec to follow up on earlier ' +
        'work without re-explaining the context.',
      inputSchema: resumeShape,
      annotations: WRITES,
    },
    async (input) =>
      guard(async () => {
        const outcome = await resumeTool(context, input);
        return ok(describeOutcome(outcome), outcomePayload(outcome));
      }),
  );

  server.registerTool(
    'codex_fork',
    {
      title: 'Fork a Codex session',
      description:
        'Branch an existing Codex session into a new one, leaving the original untouched. Useful ' +
        'for trying a different approach from a shared starting point.',
      inputSchema: forkShape,
      annotations: WRITES,
    },
    async (input) =>
      guard(async () => {
        const outcome = await forkTool(context, input);
        return ok(describeOutcome(outcome), outcomePayload(outcome));
      }),
  );

  server.registerTool(
    'codex_review',
    {
      title: 'Review code with Codex',
      description:
        'Run a Codex code review over uncommitted changes (default), a diff against a base branch, ' +
        'or a specific commit. Optionally steer it with custom instructions.',
      inputSchema: reviewShape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (input) =>
      guard(async () => {
        const outcome = await reviewTool(context, input);
        return ok(describeOutcome(outcome), outcomePayload(outcome));
      }),
  );

  server.registerTool(
    'codex_apply',
    {
      title: 'Apply a Codex diff',
      description:
        'Apply the latest diff produced by a Codex task to the local working tree, as a git apply. ' +
        'Modifies files on disk.',
      inputSchema: applyShape,
      annotations: WRITES,
    },
    async (input) =>
      guard(async () => {
        const outcome = await applyTool(context, input);
        return ok(describeOutcome(outcome), outcomePayload(outcome));
      }),
  );

  server.registerTool(
    'codex_list_sessions',
    {
      title: 'List Codex sessions',
      description:
        'List recorded Codex sessions with their id, name, working directory and last update, read ' +
        'straight from disk. Use it to find a session_id for codex_resume or codex_fork.',
      inputSchema: listSessionsShape,
      annotations: READS,
    },
    async (input) =>
      guard(async () => {
        const { sessions } = await listSessionsTool(context, input);
        const text =
          sessions.length === 0
            ? 'No Codex session recorded.'
            : sessions
                .map((s) => `${s.id}  ${s.name ?? '(unnamed)'}  ${s.cwd ?? '?'}  ${s.updatedAt ?? '?'}`)
                .join('\n');
        return ok(text, { sessions });
      }),
  );

  server.registerTool(
    'codex_generate_image',
    {
      title: 'Generate an image with Codex',
      description:
        'Generate an image using the image_gen tool built into Codex, and save it to output_path. ' +
        'No API key is needed: it runs through your Codex session. Returns the path of the file ' +
        'written, not the image bytes.',
      inputSchema: generateImageShape,
      annotations: WRITES,
    },
    async (input) =>
      guard(async () => {
        const result = await generateImageTool(context, input);
        const text =
          result.imagePath !== null
            ? `Image written to ${result.imagePath} (${result.imageBytes} bytes, via ${result.imageSource}).`
            : describeOutcome(result);
        return ok(text, {
          ...outcomePayload(result),
          image_path: result.imagePath,
          image_source: result.imageSource,
          image_bytes: result.imageBytes,
        });
      }),
  );

  server.registerTool(
    'codex_job_status',
    {
      title: 'Check a background Codex job',
      description:
        'Report the state of a run that moved to the background: whether it is still running, its ' +
        'exit code, how long it has taken and how many events it has produced.',
      inputSchema: jobStatusShape,
      annotations: READS,
    },
    async (input) =>
      guard(async () => {
        const status = jobStatusTool(context, input);
        return ok(
          `Job ${status.jobId} (${status.tool}): ${status.status}, ${Math.round(status.durationMs / 1000)}s, ` +
            `${status.eventCount} event(s).${status.error ? ` Error: ${status.error}` : ''}`,
          status as unknown as Record<string, unknown>,
        );
      }),
  );

  server.registerTool(
    'codex_job_logs',
    {
      title: 'Read background Codex job events',
      description:
        'Page through the JSONL events of a background run. Pass the returned next_cursor back as ' +
        '"since" to read only what is new. Filter with "types" to cut the noise.',
      inputSchema: jobLogsShape,
      annotations: READS,
    },
    async (input) =>
      guard(async () => {
        const page = jobLogsTool(context, input);
        return ok(`${page.events.length} event(s), next cursor ${page.nextCursor}, status ${page.status}.`, {
          job_id: page.jobId,
          status: page.status,
          events: page.events,
          next_cursor: page.nextCursor,
          dropped: page.dropped,
        });
      }),
  );

  server.registerTool(
    'codex_job_cancel',
    {
      title: 'Cancel a background Codex job',
      description:
        'Stop a run that is still going: SIGTERM first, then SIGKILL after a grace period. Reports ' +
        'honestly whether this call is what cancelled it.',
      inputSchema: jobCancelShape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input) =>
      guard(async () => {
        const result = jobCancelTool(context, input);
        return ok(
          result.cancelled
            ? `Job ${result.jobId} cancelled.`
            : `Job ${result.jobId} was not cancelled; it is already ${result.status}.`,
          { job_id: result.jobId, cancelled: result.cancelled, status: result.status },
        );
      }),
  );

  return server;
}
