/**
 * The hybrid execution model.
 *
 * A Codex run takes anywhere from seconds to tens of minutes, while MCP clients
 * cut tool calls off far sooner. So every run races its own timeout:
 *
 * - finishes first  -> the caller gets the complete result inline, one round trip;
 * - timeout first   -> the process keeps going, the caller gets a `job_id` and
 *                      polls `codex_job_status` / `codex_job_logs`.
 *
 * The run is never cancelled by the timeout. Losing ten minutes of model work to
 * an arbitrary client deadline is the failure mode this whole design exists to
 * avoid.
 */

import type { CodexRunner } from '../codex/runner.ts';
import type { CommandExecution, CodexUsage } from '../codex/events.ts';
import type { JobRecord, JobStatus, JobStore } from './store.ts';

export interface HybridContext {
  runner: CodexRunner;
  jobs: JobStore;
}

export interface HybridSpec {
  tool: string;
  args: string[];
  stdin?: string;
  cwd?: string;
  env?: Record<string, string>;
  /** 0 means: do not wait at all, return a job id immediately. */
  timeoutMs: number;
}

export interface HybridOutcome {
  jobId: string;
  /** `completed` = ran to term inline; `background` = still running. */
  mode: 'completed' | 'background';
  status: JobStatus;
  threadId: string | null;
  finalMessage: string | null;
  messages: string[];
  commands: CommandExecution[];
  usage: CodexUsage | null;
  errors: string[];
  exitCode: number | null;
  stderr: string;
  aborted: boolean;
  durationMs: number;
  eventCount: number;
}

/** stderr is diagnostic, not payload: keep the tail, which holds the error. */
const STDERR_LIMIT = 4_000;

function trimStderr(stderr: string): string {
  if (stderr.length <= STDERR_LIMIT) return stderr;
  return `...[truncated]\n${stderr.slice(-STDERR_LIMIT)}`;
}

export async function runHybrid(context: HybridContext, spec: HybridSpec): Promise<HybridOutcome> {
  const controller = new AbortController();
  const job: JobRecord = context.jobs.create({
    tool: spec.tool,
    cancel: () => controller.abort(),
  });

  let lastSummary = { threadId: null as string | null, messages: [] as string[] };

  const runPromise = context.runner
    .run({
      args: spec.args,
      stdin: spec.stdin,
      cwd: spec.cwd,
      env: spec.env,
      signal: controller.signal,
      onEvent: (event) => {
        job.recordEvent(event);
        // Track the thread id eagerly: a run that times out must still be able
        // to report which Codex session it created, so the caller can resume it.
        if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
          lastSummary.threadId = event.thread_id;
        }
      },
    })
    .then((result) => {
      job.finish({
        exitCode: result.aborted ? null : result.exitCode,
        error: result.errorMessage,
      });
      return result;
    });

  // Swallow rejections on the detached path; the job carries the outcome.
  runPromise.catch(() => undefined);

  const timedOut = Symbol('timed-out');

  // The race timer is deliberately *not* unref-ed: it is the only thing that
  // can resolve this call while the run is still going, so letting the event
  // loop drain past it would strand the caller forever. It is cleared as soon
  // as the race is decided, so a long timeout never outlives a fast run.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let raced: Awaited<typeof runPromise> | typeof timedOut;

  if (spec.timeoutMs <= 0) {
    raced = timedOut;
  } else {
    try {
      raced = await Promise.race([
        runPromise,
        new Promise<typeof timedOut>((resolve) => {
          timer = setTimeout(() => resolve(timedOut), spec.timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  if (raced === timedOut) {
    const partial = job.eventsSince(0);
    return {
      jobId: job.id,
      mode: 'background',
      status: job.status,
      threadId: lastSummary.threadId,
      finalMessage: null,
      messages: [],
      commands: [],
      usage: null,
      errors: [],
      exitCode: null,
      stderr: '',
      aborted: false,
      durationMs: job.durationMs,
      eventCount: partial.nextCursor,
    };
  }

  const result = raced;
  return {
    jobId: job.id,
    mode: 'completed',
    status: job.status,
    threadId: result.summary.threadId ?? lastSummary.threadId,
    finalMessage: result.summary.finalMessage,
    messages: result.summary.messages,
    commands: result.summary.commands,
    usage: result.summary.usage,
    errors: result.errorMessage ? [...result.summary.errors, result.errorMessage] : result.summary.errors,
    exitCode: result.exitCode,
    stderr: trimStderr(result.stderr),
    aborted: result.aborted,
    durationMs: job.durationMs,
    eventCount: result.summary.eventCount,
  };
}
