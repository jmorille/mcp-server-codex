/**
 * Parser for the JSONL stream produced by `codex exec --json`.
 *
 * Two design constraints shape this module:
 *
 * 1. **Defensive by default.** Codex ships fast and adds event and item types
 *    between releases. An unknown `item.type` is kept verbatim rather than
 *    dropped, so a Codex upgrade degrades the summary instead of breaking the
 *    server.
 * 2. **Stream-friendly.** Chunks from a child process split anywhere, including
 *    mid-token, so lines are buffered until a newline arrives.
 */

export interface CodexEvent {
  type: string;
  [key: string]: unknown;
}

export interface CodexItem {
  id: string;
  type: string;
  [key: string]: unknown;
}

export interface CommandExecution {
  id: string;
  command: string;
  status: string;
  exitCode: number | null;
  output: string;
}

export interface CodexUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface RunSummary {
  threadId: string | null;
  messages: string[];
  finalMessage: string | null;
  commands: CommandExecution[];
  items: CodexItem[];
  usage: CodexUsage | null;
  errors: string[];
  /** Lines that were not valid JSON, e.g. Codex's own stdout chatter. */
  unparsedLines: string[];
  eventCount: number;
}

export interface EventAccumulator {
  /** Feed a chunk of stdout; returns the events completed by this chunk. */
  ingest(chunk: string): CodexEvent[];
  /** Flush a trailing line that never received its newline. */
  end(): CodexEvent[];
  summary(): RunSummary;
  events(): CodexEvent[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Pull a human-readable message out of the many shapes Codex uses for
 * failures: a top-level `message`, a nested `error.message`, or a bare string.
 */
function extractErrorMessage(source: Record<string, unknown>): string | null {
  const direct = asString(source.message);
  if (direct) return direct;

  const nested = source.error;
  if (typeof nested === 'string') return nested;
  if (isRecord(nested)) {
    const nestedMessage = asString(nested.message);
    if (nestedMessage) return nestedMessage;
  }
  return null;
}

function toUsage(value: unknown): CodexUsage | null {
  if (!isRecord(value)) return null;
  return {
    inputTokens: asNumber(value.input_tokens, 0),
    cachedInputTokens: asNumber(value.cached_input_tokens, 0),
    cacheWriteInputTokens: asNumber(value.cache_write_input_tokens, 0),
    outputTokens: asNumber(value.output_tokens, 0),
    reasoningOutputTokens: asNumber(value.reasoning_output_tokens, 0),
  };
}

export function createEventAccumulator(): EventAccumulator {
  let buffer = '';
  const allEvents: CodexEvent[] = [];
  const unparsedLines: string[] = [];
  const errors: string[] = [];
  const messages: string[] = [];
  /** Keyed by item id so `item.started` is superseded by `item.completed`. */
  const itemsById = new Map<string, CodexItem>();
  let threadId: string | null = null;
  let usage: CodexUsage | null = null;

  function recordItem(raw: unknown): void {
    if (!isRecord(raw)) return;
    const type = asString(raw.type);
    if (!type) return;
    // Items without an id cannot be de-duplicated; give them a synthetic one
    // so they are still reported rather than silently merged together.
    const id = asString(raw.id) ?? `anonymous-${itemsById.size}`;

    const item: CodexItem = { ...raw, id, type };
    itemsById.set(id, item);

    if (type === 'agent_message') {
      const text = asString(raw.text);
      if (text !== null) messages.push(text);
    } else if (type === 'error') {
      const message = extractErrorMessage(raw);
      if (message) errors.push(message);
    }
  }

  function handle(event: CodexEvent): void {
    switch (event.type) {
      case 'thread.started': {
        threadId = asString(event.thread_id) ?? threadId;
        break;
      }
      case 'turn.completed': {
        usage = toUsage(event.usage) ?? usage;
        break;
      }
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        recordItem(event.item);
        break;
      }
      case 'error':
      case 'turn.failed':
      case 'thread.failed': {
        const message = extractErrorMessage(event);
        if (message) errors.push(message);
        break;
      }
      default:
        break;
    }
  }

  function consumeLine(line: string): CodexEvent | null {
    const trimmed = line.trim();
    if (trimmed === '') return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      unparsedLines.push(trimmed);
      return null;
    }

    if (!isRecord(parsed)) {
      unparsedLines.push(trimmed);
      return null;
    }
    const type = asString(parsed.type);
    if (type === null) {
      unparsedLines.push(trimmed);
      return null;
    }

    const event: CodexEvent = { ...parsed, type };
    allEvents.push(event);
    handle(event);
    return event;
  }

  return {
    ingest(chunk: string): CodexEvent[] {
      buffer += chunk;
      const produced: CodexEvent[] = [];
      let newlineAt = buffer.indexOf('\n');

      while (newlineAt !== -1) {
        const line = buffer.slice(0, newlineAt);
        buffer = buffer.slice(newlineAt + 1);
        const event = consumeLine(line);
        if (event) produced.push(event);
        newlineAt = buffer.indexOf('\n');
      }
      return produced;
    },

    end(): CodexEvent[] {
      if (buffer === '') return [];
      const remaining = buffer;
      buffer = '';
      const event = consumeLine(remaining);
      return event ? [event] : [];
    },

    events(): CodexEvent[] {
      return [...allEvents];
    },

    summary(): RunSummary {
      const items = [...itemsById.values()];
      const commands: CommandExecution[] = items
        .filter((item) => item.type === 'command_execution')
        .map((item) => ({
          id: item.id,
          command: asString(item.command) ?? '',
          status: asString(item.status) ?? 'unknown',
          exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
          output: asString(item.aggregated_output) ?? '',
        }));

      return {
        threadId,
        messages: [...messages],
        finalMessage: messages.length > 0 ? (messages[messages.length - 1] as string) : null,
        commands,
        items,
        usage,
        errors: [...errors],
        unparsedLines: [...unparsedLines],
        eventCount: allEvents.length,
      };
    },
  };
}
