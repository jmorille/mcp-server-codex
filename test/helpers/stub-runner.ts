import type { CodexRunner, RunRequest, RunResult } from '../../src/codex/runner.ts';
import { createEventAccumulator } from '../../src/codex/events.ts';
import type { CodexEvent } from '../../src/codex/events.ts';

export interface StubRunner extends CodexRunner {
  /** Requests the runner received, in order. */
  readonly calls: RunRequest[];
  /** Push an event to the in-flight run, as the real streamer would. */
  emit(event: CodexEvent): void;
  /** Let the in-flight run finish. */
  settle(outcome?: Partial<RunResult>): void;
  /** Resolves once a run is actually in flight. */
  started(): Promise<void>;
}

/**
 * A `CodexRunner` the test drives by hand.
 *
 * Holding the run open until `settle()` is what makes the timeout / background
 * hand-off testable in milliseconds instead of minutes.
 */
export function createStubRunner(): StubRunner {
  const calls: RunRequest[] = [];
  let onEvent: ((event: CodexEvent) => void) | undefined;
  let resolveRun: ((result: RunResult) => void) | undefined;
  let announceStart: (() => void) | undefined;
  const accumulator = createEventAccumulator();

  const startedPromise = new Promise<void>((resolve) => {
    announceStart = resolve;
  });

  return {
    calls,

    emit(event: CodexEvent): void {
      accumulator.ingest(JSON.stringify(event) + '\n');
      onEvent?.(event);
    },

    settle(outcome: Partial<RunResult> = {}): void {
      resolveRun?.({
        exitCode: 0,
        summary: accumulator.summary(),
        stderr: '',
        aborted: false,
        errorMessage: null,
        ...outcome,
      });
    },

    started(): Promise<void> {
      return startedPromise;
    },

    run(request: RunRequest): Promise<RunResult> {
      calls.push(request);
      onEvent = request.onEvent;

      request.signal?.addEventListener('abort', () => {
        resolveRun?.({
          exitCode: null,
          summary: accumulator.summary(),
          stderr: '',
          aborted: true,
          errorMessage: null,
        });
      });

      return new Promise<RunResult>((resolve) => {
        resolveRun = resolve;
        announceStart?.();
      });
    },

    async version(): Promise<string | null> {
      return 'codex-cli 0.154.0';
    },
  };
}
