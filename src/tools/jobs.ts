/**
 * Inspection and control of background runs.
 *
 * These are the other half of the hybrid model: once a run outlives its
 * timeout, this is how the calling agent follows it to the end.
 */

import type { CodexEvent } from '../codex/events.ts';
import type { JobRecord, JobStatus } from '../jobs/store.ts';
import type { ToolContext } from './types.ts';

export class UnknownJobError extends Error {
  constructor(jobId: string) {
    super(
      `No job with id "${jobId}". Jobs live for the duration of this MCP session ` +
        'and are reaped a while after they finish.',
    );
    this.name = 'UnknownJobError';
  }
}

function requireJob(context: ToolContext, jobId: string): JobRecord {
  const job = context.jobs.get(jobId);
  if (!job) throw new UnknownJobError(jobId);
  return job;
}

export interface JobStatusInput {
  job_id: string;
}

export interface JobStatusResult {
  jobId: string;
  tool: string;
  status: JobStatus;
  exitCode: number | null;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  eventCount: number;
  droppedEvents: number;
}

export function jobStatusTool(context: ToolContext, input: JobStatusInput): JobStatusResult {
  const job = requireJob(context, input.job_id);
  return {
    jobId: job.id,
    tool: job.tool,
    status: job.status,
    exitCode: job.exitCode,
    error: job.error,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    durationMs: job.durationMs,
    eventCount: job.totalEvents,
    droppedEvents: job.droppedEvents,
  };
}

export interface JobLogsInput {
  job_id: string;
  /** Absolute cursor returned by a previous call. */
  since?: number;
  types?: string[];
  limit?: number;
}

export interface JobLogsResult {
  jobId: string;
  status: JobStatus;
  events: CodexEvent[];
  nextCursor: number;
  /** Events evicted by the ring buffer before this cursor could read them. */
  dropped: number;
}

const DEFAULT_LOG_LIMIT = 200;

export function jobLogsTool(context: ToolContext, input: JobLogsInput): JobLogsResult {
  const job = requireJob(context, input.job_id);
  const since = input.since ?? 0;
  const page = job.eventsSince(since);

  const limit = input.limit ?? DEFAULT_LOG_LIMIT;
  // Truncation happens before filtering so the cursor always maps to a real
  // position in the stream; filtering afterwards would make it ambiguous.
  const window = page.events.slice(0, limit);
  const nextCursor = page.nextCursor - (page.events.length - window.length);

  const events =
    input.types && input.types.length > 0
      ? window.filter((event) => input.types?.includes(event.type))
      : window;

  return { jobId: job.id, status: job.status, events, nextCursor, dropped: page.dropped };
}

export interface JobCancelInput {
  job_id: string;
}

export interface JobCancelResult {
  jobId: string;
  cancelled: boolean;
  status: JobStatus;
}

export function jobCancelTool(context: ToolContext, input: JobCancelInput): JobCancelResult {
  const job = requireJob(context, input.job_id);
  const cancelled = job.cancel();
  return { jobId: job.id, cancelled, status: job.status };
}
