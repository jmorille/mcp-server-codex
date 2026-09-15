/**
 * The one place in the server that touches the operating system.
 *
 * Every tool goes through `CodexRunner`, which makes the interface the seam the
 * tests inject at: unit tests drive a fake CLI through the very same spawn,
 * stdin, streaming and cancellation code the real binary goes through.
 *
 * Two behaviours here are load-bearing:
 *
 * - **stdin is always written and always closed.** Codex reads stdin whenever
 *   it is not a TTY ("Reading additional input from stdin..."), so leaving it
 *   open hangs the run forever.
 * - **Abort escalates.** SIGTERM first, SIGKILL after a grace period, because a
 *   Codex run that is mid-tool-call does not always honour the polite signal.
 */

import { execa } from 'execa';
import type { ResultPromise } from 'execa';

import { createEventAccumulator } from './events.ts';
import type { CodexEvent, RunSummary } from './events.ts';

export interface RunRequest {
  args: string[];
  /** Prompt text; Codex reads it because argv ends with `-`. */
  stdin?: string;
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** Called for each parsed event as it arrives, for live job logs. */
  onEvent?: (event: CodexEvent) => void;
}

export interface RunResult {
  exitCode: number | null;
  summary: RunSummary;
  stderr: string;
  aborted: boolean;
  /** Set when the process could not be started or run at all. */
  errorMessage: string | null;
}

export interface CodexRunner {
  run(request: RunRequest): Promise<RunResult>;
  /** `codex --version`, or null when the binary is unusable. */
  version(): Promise<string | null>;
}

export interface CodexRunnerOptions {
  binary: string;
  /**
   * Arguments injected before every call. Lets a wrapper command stand in for
   * the binary — which is exactly how the tests substitute a fake CLI.
   */
  argsPrefix?: string[];
  env?: Record<string, string>;
  /** How long a SIGTERM gets before SIGKILL follows. */
  killGraceMs?: number;
}

const DEFAULT_KILL_GRACE_MS = 5_000;

export function createCodexRunner(options: CodexRunnerOptions): CodexRunner {
  const argsPrefix = options.argsPrefix ?? [];
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  function spawn(args: string[], request: Pick<RunRequest, 'cwd' | 'env' | 'stdin'>): ResultPromise {
    return execa(options.binary, [...argsPrefix, ...args], {
      // Always a string, never undefined: an unwritten stdin is an open stdin,
      // and an open stdin makes Codex wait forever.
      input: request.stdin ?? '',
      cwd: request.cwd,
      env: { ...options.env, ...request.env },
      extendEnv: true,
      reject: false,
      buffer: false,
      encoding: 'utf8',
      windowsHide: true,
      stripFinalNewline: false,
    }) as ResultPromise;
  }

  return {
    async run(request: RunRequest): Promise<RunResult> {
      const accumulator = createEventAccumulator();
      let stderr = '';
      let aborted = false;
      let errorMessage: string | null = null;

      let subprocess: ResultPromise;
      try {
        subprocess = spawn(request.args, request);
      } catch (error) {
        return {
          exitCode: null,
          summary: accumulator.summary(),
          stderr: '',
          aborted: false,
          errorMessage: error instanceof Error ? error.message : String(error),
        };
      }

      const emit = (chunk: string): void => {
        for (const event of accumulator.ingest(chunk)) request.onEvent?.(event);
      };

      subprocess.stdout?.on('data', (chunk: unknown) => emit(String(chunk)));
      subprocess.stderr?.on('data', (chunk: unknown) => {
        stderr += String(chunk);
      });

      let forceKillTimer: NodeJS.Timeout | undefined;
      const onAbort = (): void => {
        aborted = true;
        subprocess.kill('SIGTERM');
        forceKillTimer = setTimeout(() => subprocess.kill('SIGKILL'), killGraceMs);
        // A pending timer must not hold the event loop open on shutdown.
        forceKillTimer.unref?.();
      };

      if (request.signal) {
        if (request.signal.aborted) onAbort();
        else request.signal.addEventListener('abort', onAbort, { once: true });
      }

      let exitCode: number | null = null;
      try {
        const result = await subprocess;
        exitCode = result.exitCode ?? null;
        if (result.failed && result.exitCode === undefined) {
          errorMessage = result.message ?? 'codex failed to start';
        }
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      } finally {
        if (forceKillTimer) clearTimeout(forceKillTimer);
        request.signal?.removeEventListener('abort', onAbort);
      }

      for (const event of accumulator.end()) request.onEvent?.(event);

      // A process that never started reports no exit code; give callers a
      // non-zero one so "did it work" stays a single check.
      if (exitCode === null && errorMessage !== null) exitCode = -1;

      return { exitCode, summary: accumulator.summary(), stderr, aborted, errorMessage };
    },

    async version(): Promise<string | null> {
      try {
        const result = await execa(options.binary, [...argsPrefix, '--version'], {
          env: { ...options.env },
          extendEnv: true,
          reject: false,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 15_000,
        });
        if (result.failed || result.exitCode !== 0) return null;
        return String(result.stdout).trim() || null;
      } catch {
        return null;
      }
    },
  };
}
