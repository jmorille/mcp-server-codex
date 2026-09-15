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

import { createRequire } from 'node:module';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { describeOutcome } from './tools/common.ts';
import { execTool } from './tools/exec.ts';
import { resumeTool, forkTool, listSessionsTool } from './tools/sessions.ts';
import { reviewTool } from './tools/review.ts';
import { applyTool } from './tools/apply.ts';
import { generateImageTool } from './tools/image.ts';
import { jobStatusTool, jobLogsTool, jobCancelTool } from './tools/jobs.ts';
import { inboxTool, replyTool, tellTool } from './tools/bridge.ts';
import type { ToolContext } from './tools/types.ts';
import type { HybridOutcome } from './jobs/hybrid.ts';
import {
  applyShape,
  execShape,
  forkShape,
  generateImageShape,
  inboxShape,
  jobCancelShape,
  jobLogsShape,
  jobStatusShape,
  listSessionsShape,
  replyShape,
  resumeShape,
  reviewShape,
  tellShape,
} from './schemas.ts';

export const SERVER_NAME = 'mcp-server-codex';

/**
 * Read from the manifest rather than hardcoded.
 *
 * A duplicated constant drifted once already and put a version on the wire
 * that no release ever had. `package.json` sits one level above both `src/`
 * and `dist/`, so the same relative path works in development and in the
 * published package.
 */
const requireFromHere = createRequire(import.meta.url);
export const SERVER_VERSION: string = (
  requireFromHere('../package.json') as { version: string }
).version;

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

/**
 * snake_case everywhere, including inside nested objects.
 *
 * The internal types are camelCase, as TypeScript should be; the wire format is
 * snake_case, as the rest of the tool surface is. Mixing the two in one
 * response — which this used to do inside `usage` and `commands` — leaves the
 * calling agent guessing which convention a given field follows.
 */
function usagePayload(usage: HybridOutcome['usage']): Record<string, number> | null {
  if (usage === null) return null;
  return {
    input_tokens: usage.inputTokens,
    cached_input_tokens: usage.cachedInputTokens,
    cache_write_input_tokens: usage.cacheWriteInputTokens,
    output_tokens: usage.outputTokens,
    reasoning_output_tokens: usage.reasoningOutputTokens,
  };
}

function commandsPayload(commands: HybridOutcome['commands']): Record<string, unknown>[] {
  return commands.map((command) => ({
    id: command.id,
    command: command.command,
    status: command.status,
    exit_code: command.exitCode,
    output: command.output,
  }));
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
    commands: commandsPayload(outcome.commands),
    usage: usagePayload(outcome.usage),
    errors: outcome.errors,
    exit_code: outcome.exitCode,
    stderr: outcome.stderr,
    aborted: outcome.aborted,
    duration_ms: outcome.durationMs,
    event_count: outcome.eventCount,
  };
}

/**
 * Name this instance's presets in the tool description.
 *
 * Specialisation lives in the deployment, not in the package, so a calling
 * agent has no other way to learn that a preset exists. An instance with none
 * says nothing, rather than advertising a feature it cannot serve.
 */
function presetHint(context: ToolContext): string {
  const names = Object.keys(context.imagePresets);
  if (names.length === 0) return '';

  return (
    ` This instance is configured with named presets: ${names.join(', ')}. ` +
    'Pass one as "preset" to reuse its subject, style and reference art instead of restating them, ' +
    'and describe only what differs in the prompt (a pose, an angle, a variation).'
  );
}

const WRITES = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
const READS = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

/**
 * What a client sees before it has called anything.
 *
 * This is the text an operator reads when deciding whether to install a server
 * that can run code on their machine, so it says what it drives, what that is
 * good for, and where the limits are — not just that it exists.
 */
export const SERVER_DESCRIPTION =
  'Drives the Codex CLI locally, so an agent can hand a coding task to a second autonomous agent ' +
  'instead of doing it turn by turn. Codex is at its best on work that is long, mechanical and ' +
  'verifiable: a refactor across many files, making a failing suite pass, a code review, tracing a ' +
  'bug through an unfamiliar codebase. It runs commands and edits files inside a sandbox, under a ' +
  'directory allowlist this server enforces before any process starts. Runs that outlast the caller ' +
  'move to the background and are polled by job id, sessions can be resumed or forked, and a built-in ' +
  'two-way bridge lets a running Codex agent ask the calling agent a question mid-task rather than ' +
  'guessing. Also exposes Codex image generation.';

/**
 * Guidance for the agent on the other end.
 *
 * It already sees every tool and its schema, so repeating them here would be
 * noise. What it cannot see is *when* delegating beats doing the work itself,
 * and which of this server's behaviours will surprise it.
 */
export const SERVER_INSTRUCTIONS = [
  'Use Codex when the work is large, repetitive or needs its own verify loop — a refactor spanning ' +
    'many files, making a test suite pass, reviewing a diff, or exploring a codebase you do not know. ' +
    'For a single edit you already understand, doing it yourself is faster and cheaper than a round ' +
    'trip through another agent.',
  'Give it an outcome, not a procedure. Codex runs its own commands and iterates; a prompt that ' +
    'states the goal and how to check it ("make `npm test` pass without weakening the assertions") ' +
    'produces better work than a list of steps.',
  'Runs are hybrid. If a call outlasts timeout_seconds it does not fail and is not cancelled: it ' +
    'returns mode="background" with a job_id, and you follow it with codex_job_status and ' +
    'codex_job_logs (cursor-paged via since), or stop it with codex_job_cancel.',
  'Every run reports a thread_id. Pass it to codex_resume to continue with the full history instead ' +
    'of re-explaining the context, or to codex_fork to try a different approach from the same ' +
    'starting point while leaving the original intact.',
  'Two guardrails will reject a call before anything is spawned, and both messages are actionable: ' +
    'paths outside the server allowlist (cwd, add_dir, images, output_path), and sandbox levels the ' +
    'server was not unlocked for. The sandbox defaults to workspace-write; pass sandbox="read-only" ' +
    'when the task is meant to inspect rather than change.',
  'The bridge is always live. A Codex run can ask you a question mid-task and block on the answer: ' +
    'poll codex_inbox while a run is in flight, answer with codex_reply (the run resumes at once), ' +
    'and use codex_tell to correct or stop it. Omitting job_id on codex_tell reaches every run.',
].join('\n\n');

export function createServer(context: ToolContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, description: SERVER_DESCRIPTION },
    { instructions: SERVER_INSTRUCTIONS },
  );

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
        'written, not the image bytes.' + presetHint(context),
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

  // --- the two-way bridge ------------------------------------------------
  //
  // Every Codex run this server starts is spawned with a bridge of its own, so
  // these three tools are always live. They are how a run that needs a decision
  // gets one without dying, and how this agent interrupts a run in flight.

  server.registerTool(
    'codex_inbox',
    {
      title: 'Read messages from Codex',
      description:
        'Collect anything a running Codex agent has sent — a question it is blocked on, a finding, a ' +
        'warning. Cheap and non-blocking, so it is worth calling between other tools while a run is in ' +
        'flight. Pass the next_cursor from the previous call to see only what is new; awaiting_answer ' +
        'counts the questions still waiting on codex_reply.',
      inputSchema: inboxShape,
      annotations: READS,
    },
    async (input) => {
      const result = await inboxTool(context, input);
      const text =
        result.count === 0
          ? 'Nothing from Codex.'
          : result.messages
              .map((m) => `[${m.kind}${m.answered ? '' : ', unanswered'}] ${m.text}`)
              .join('\n');
      return ok(text, { ...result });
    },
  );

  server.registerTool(
    'codex_reply',
    {
      title: 'Answer a Codex question',
      description:
        'Answer a question codex_inbox reported. The Codex run is blocked waiting for exactly this, so ' +
        'answering promptly is what keeps it moving; if it has already timed out the answer is still ' +
        'delivered and collected at its next turn. Fails if no such question exists, rather than posting ' +
        'an answer nobody is waiting for.',
      inputSchema: replyShape,
      annotations: WRITES,
    },
    (input) => guard(async () => ok('Answer delivered.', { ...(await replyTool(context, input)) })),
  );

  server.registerTool(
    'codex_tell',
    {
      title: 'Send Codex a message',
      description:
        'Send a running Codex agent something it did not ask for — a correction, a change of direction, ' +
        'a stop. It arrives at the next tool turn of that run rather than interrupting it mid-command. ' +
        'Omit job_id to reach every run at once.',
      inputSchema: tellShape,
      annotations: WRITES,
    },
    (input) => guard(async () => ok('Queued for Codex.', { ...(await tellTool(context, input)) })),
  );

  return server;
}
