/**
 * The shared mailbox behind the two-way bridge.
 *
 * The two faces of the bridge live in *different processes* — Codex spawns its
 * own copy of the bridge server — so they share nothing but the filesystem.
 * Everything here therefore reads from disk on every call; nothing is cached in
 * memory, because a cache would be a cache of the other process's state.
 *
 * One message per file, named so that a plain lexicographic sort reproduces
 * posting order. That makes the cursor a simple index and keeps the whole
 * protocol inspectable with `ls` when something goes wrong.
 */

import fs from 'node:fs';
import path from 'node:path';

export type Party = 'claude' | 'codex';
export type MessageKind = 'question' | 'answer' | 'note';

export interface Message {
  id: string;
  from: Party;
  kind: MessageKind;
  text: string;
  in_reply_to: string | null;
  /** Which Codex run produced this, when there is one. Null for Claude's own messages. */
  thread: string | null;
  created_at: string;
}

export interface ReadPage {
  messages: Message[];
  /**
   * How many messages this reader has been handed so far.
   *
   * Informational, not a position to read from. It used to be an index into the
   * sorted listing, which two processes cannot agree on: the bridge's own
   * counter restarts at 1 while a long-lived server's is well past it, so a
   * message written in the same millisecond sorted *before* a cursor already
   * past it and was never delivered.
   */
  nextCursor: number;
}

export interface Mailbox {
  post(input: { from: Party; kind: MessageKind; text: string; inReplyTo?: string; thread?: string }): Message;
  /**
   * Everything addressed to `audience` that this handle has not handed over yet.
   *
   * Delivery is tracked by message id rather than by position, so it does not
   * depend on two processes agreeing on an order they cannot agree on. `thread`
   * narrows to one Codex run, plus anything addressed to no run in particular;
   * omit it to watch every run at once.
   */
  read(options: { audience: Party; thread?: string }): ReadPage;
  /** Look at the mailbox without consuming anything. */
  peek(options: { audience: Party; thread?: string }): Message[];
  /** Poll until a reply to `to` appears, or the timeout elapses. */
  waitForReply(options: { to: string; timeoutMs: number; pollMs?: number }): Promise<Message | null>;
  readonly dir: string;
}

const DEFAULT_POLL_MS = 250;

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Names sort chronologically: a padded millisecond timestamp orders messages
 * across processes, and an in-process counter separates those posted inside the
 * same millisecond.
 */
function nextFileName(counter: number): string {
  const stamp = String(Date.now()).padStart(15, '0');
  return `${stamp}-${String(counter).padStart(6, '0')}-${randomSuffix()}`;
}

function isMessage(value: unknown): value is Message {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.id === 'string' &&
    (m.from === 'claude' || m.from === 'codex') &&
    typeof m.text === 'string' &&
    typeof m.created_at === 'string'
  );
}

export function openMailbox(dir: string): Mailbox {
  let counter = 0;
  /**
   * What each side has already been handed, by message id.
   *
   * In memory, and deliberately so: it is the reader's own bookkeeping, and a
   * fresh process — a new Codex run, a restarted server — should see the
   * backlog rather than inherit someone else's idea of what was read.
   */
  const delivered: Record<Party, Set<string>> = { claude: new Set(), codex: new Set() };

  function listFiles(): string[] {
    try {
      return fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .sort();
    } catch {
      // No directory yet simply means nobody has written anything.
      return [];
    }
  }

  function loadAll(): Message[] {
    const messages: Message[] = [];
    for (const name of listFiles()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      } catch {
        // A file being written by the other process, or corrupted: skip it
        // rather than failing the whole read. It will be readable next poll.
        continue;
      }
      if (isMessage(parsed)) messages.push({ ...parsed, thread: parsed.thread ?? null });
    }
    return messages;
  }

  /** What this audience is allowed to see, consumed or not. */
  function visible(all: Message[], options: { audience: Party; thread?: string }): Message[] {
    return all
      .filter((message) => message.from !== options.audience)
      // A message with no thread is addressed to everyone: filtering it out
      // would make a broadcast reach nobody.
      .filter(
        (message) => options.thread === undefined || message.thread === null || message.thread === options.thread,
      );
  }

  return {
    dir,

    post(input): Message {
      if (input.text.trim() === '') {
        throw new Error('Refusing to post an empty message.');
      }

      fs.mkdirSync(dir, { recursive: true });
      counter += 1;

      const base = nextFileName(counter);
      const message: Message = {
        id: `${base}`,
        from: input.from,
        kind: input.kind,
        text: input.text,
        in_reply_to: input.inReplyTo ?? null,
        thread: input.thread ?? null,
        created_at: new Date().toISOString(),
      };

      // Write then rename: a reader in the other process must never observe a
      // half-written file, and rename is atomic on both Windows and POSIX.
      const temporary = path.join(dir, `${base}.tmp`);
      fs.writeFileSync(temporary, JSON.stringify(message, null, 2));
      fs.renameSync(temporary, path.join(dir, `${base}.json`));

      return message;
    },

    read(options): ReadPage {
      const seen = delivered[options.audience];
      const messages = visible(loadAll(), options).filter((message) => !seen.has(message.id));

      for (const message of messages) seen.add(message.id);

      return { messages, nextCursor: seen.size };
    },

    peek(options): Message[] {
      return visible(loadAll(), options);
    },

    async waitForReply(options): Promise<Message | null> {
      const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
      const deadline = Date.now() + options.timeoutMs;

      for (;;) {
        const found = loadAll().find((message) => message.in_reply_to === options.to);
        if (found) return found;
        if (Date.now() >= deadline) return null;

        const remaining = deadline - Date.now();
        await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
      }
    },
  };
}
