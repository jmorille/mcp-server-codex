/**
 * In-memory registry of background Codex runs.
 *
 * This is what makes the hybrid execution model work: a tool call that outlives
 * its timeout keeps running here and is reachable afterwards through
 * `codex_job_status` / `codex_job_logs` / `codex_job_cancel`.
 *
 * The store is deliberately passive — it owns no process and spawns nothing.
 * The runner drives it. That keeps the whole lifecycle testable with a fake
 * clock and no child process in sight.
 *
 * Lifetime is the MCP session: a stdio server dies with its client, and a job
 * that outlived its client has nobody left to report to.
 */

import type { CodexEvent } from '../codex/events.ts';

export type JobStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface EventPage {
  events: CodexEvent[];
  /** Absolute cursor to pass back on the next poll. */
  nextCursor: number;
  /** Events evicted by the ring buffer before the caller could read them. */
  dropped: number;
}

export interface JobRecord {
  readonly id: string;
  readonly tool: string;
  readonly startedAt: number;
  readonly status: JobStatus;
  readonly endedAt: number | null;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly error: string | null;
  readonly droppedEvents: number;
  readonly totalEvents: number;

  recordEvent(event: CodexEvent): void;
  eventsSince(cursor: number): EventPage;
  finish(outcome: { exitCode: number | null; error?: string | null }): void;
  /** @returns true if this call is the one that cancelled the job. */
  cancel(): boolean;
}

export interface JobStore {
  create(spec: { tool: string; cancel: () => void }): JobRecord;
  get(id: string): JobRecord | undefined;
  /** Newest first. */
  list(): JobRecord[];
  /** Drop finished jobs older than the TTL. @returns how many were reaped. */
  sweep(): number;
  /** @returns how many running jobs were cancelled. */
  cancelAll(): number;
}

export interface JobStoreOptions {
  /** Ring-buffer capacity per job. */
  maxEvents?: number;
  /** How long a finished job stays readable. */
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_EVENTS = 2_000;
const DEFAULT_TTL_MS = 30 * 60 * 1_000;

export function createJobStore(options: JobStoreOptions = {}): JobStore {
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;

  const jobs = new Map<string, JobRecord>();
  let sequence = 0;

  function createRecord(spec: { tool: string; cancel: () => void }): JobRecord {
    sequence += 1;
    const id = `job-${sequence}-${Math.random().toString(36).slice(2, 10)}`;
    const startedAt = now();

    let status: JobStatus = 'running';
    let endedAt: number | null = null;
    let exitCode: number | null = null;
    let error: string | null = null;

    const buffer: CodexEvent[] = [];
    /** Absolute index of buffer[0]; equals the number of evicted events. */
    let firstIndex = 0;
    let totalEvents = 0;

    function settle(next: JobStatus, outcome: { exitCode?: number | null; error?: string | null }): boolean {
      if (status !== 'running') return false;
      status = next;
      endedAt = now();
      exitCode = outcome.exitCode ?? null;
      error = outcome.error ?? null;
      return true;
    }

    const record: JobRecord = {
      id,
      tool: spec.tool,
      startedAt,

      get status() {
        return status;
      },
      get endedAt() {
        return endedAt;
      },
      get durationMs() {
        return (endedAt ?? now()) - startedAt;
      },
      get exitCode() {
        return exitCode;
      },
      get error() {
        return error;
      },
      get droppedEvents() {
        return firstIndex;
      },
      get totalEvents() {
        return totalEvents;
      },

      recordEvent(event: CodexEvent): void {
        buffer.push(event);
        totalEvents += 1;
        if (buffer.length > maxEvents) {
          buffer.shift();
          firstIndex += 1;
        }
      },

      eventsSince(cursor: number): EventPage {
        // A cursor pointing at an evicted event is served from the oldest event
        // still held rather than failing: a slow poller should lose history,
        // not the rest of the run.
        const from = Math.max(cursor, firstIndex);
        const offset = Math.max(0, from - firstIndex);
        return {
          events: buffer.slice(offset),
          nextCursor: firstIndex + buffer.length,
          dropped: Math.max(0, firstIndex - cursor),
        };
      },

      finish(outcome: { exitCode: number | null; error?: string | null }): void {
        const failed = outcome.error != null || (outcome.exitCode !== null && outcome.exitCode !== 0);
        settle(failed ? 'failed' : 'completed', outcome);
      },

      cancel(): boolean {
        const didCancel = settle('cancelled', { exitCode: null, error: null });
        if (didCancel) spec.cancel();
        return didCancel;
      },
    };

    return record;
  }

  return {
    create(spec): JobRecord {
      const record = createRecord(spec);
      jobs.set(record.id, record);
      return record;
    },

    get(id): JobRecord | undefined {
      return jobs.get(id);
    },

    list(): JobRecord[] {
      return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
    },

    sweep(): number {
      const cutoff = now() - ttlMs;
      let reaped = 0;
      for (const [id, job] of jobs) {
        if (job.endedAt !== null && job.endedAt < cutoff) {
          jobs.delete(id);
          reaped += 1;
        }
      }
      return reaped;
    },

    cancelAll(): number {
      let cancelled = 0;
      for (const job of jobs.values()) {
        if (job.cancel()) cancelled += 1;
      }
      return cancelled;
    },
  };
}
