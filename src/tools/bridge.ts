/**
 * The Claude end of the two-way bridge.
 *
 * Nothing here blocks. Claude already has a natural polling rhythm — its tool
 * turns — so the right shape on this side is a cheap read that returns whatever
 * has arrived, and two posts that return as soon as the message is on disk.
 * The blocking lives on the Codex side, where a turn cannot simply be resumed
 * later.
 *
 * `job_id` on these tools is the mailbox `thread`: the run a message belongs
 * to. Omitting it means "every run" when reading and "every run" when writing,
 * which is what makes a broadcast possible.
 */

import type { Message } from '../bridge/mailbox.ts';
import type { ToolContext } from './types.ts';

export interface InboxToolInput {
  since?: number;
  job_id?: string;
}

export interface ReplyToolInput {
  message_id: string;
  text: string;
}

export interface TellToolInput {
  message: string;
  job_id?: string;
}

export interface InboxMessage {
  id: string;
  kind: Message['kind'];
  text: string;
  job_id: string | null;
  in_reply_to: string | null;
  created_at: string;
  /** Only meaningful for questions; always true for anything else. */
  answered: boolean;
}

export interface InboxResult {
  messages: InboxMessage[];
  next_cursor: number;
  count: number;
  /** How many of these still need a codex_reply. */
  awaiting_answer: number;
}

/** Read what Codex has sent since the last call. */
export async function inboxTool(context: ToolContext, input: InboxToolInput): Promise<InboxResult> {
  const page = context.bridge.read({ audience: 'claude', since: input.since, thread: input.job_id });

  // Answers live outside the page — one posted before the cursor still answers
  // a question inside it — so the whole box is scanned for replies.
  const answered = new Set(
    context.bridge
      .read({ audience: 'codex' })
      .messages.map((message) => message.in_reply_to)
      .filter((id): id is string => id !== null),
  );

  const messages: InboxMessage[] = page.messages.map((message) => ({
    id: message.id,
    kind: message.kind,
    text: message.text,
    job_id: message.thread,
    in_reply_to: message.in_reply_to,
    created_at: message.created_at,
    answered: message.kind !== 'question' || answered.has(message.id),
  }));

  return {
    messages,
    next_cursor: page.nextCursor,
    count: messages.length,
    awaiting_answer: messages.filter((message) => !message.answered).length,
  };
}

/** Answer a question Codex is waiting on. */
export async function replyTool(context: ToolContext, input: ReplyToolInput): Promise<{ message_id: string; in_reply_to: string; job_id: string | null }> {
  const question = context.bridge
    .read({ audience: 'claude' })
    .messages.find((message) => message.id === input.message_id);

  // Posting an answer to an id nobody asked about would succeed silently and
  // leave the real question hanging until it times out.
  if (question === undefined) {
    throw new Error(
      `No message "${input.message_id}" from Codex to reply to. Call codex_inbox to see the open questions.`,
    );
  }

  // Same thread as the question: the run that asked is the run that gets the
  // answer, even when several are in flight.
  const posted = context.bridge.post({
    from: 'claude',
    kind: 'answer',
    text: input.text,
    inReplyTo: question.id,
    thread: question.thread ?? undefined,
  });

  return { message_id: posted.id, in_reply_to: question.id, job_id: posted.thread };
}

/** Send Codex something it did not ask for. */
export async function tellTool(context: ToolContext, input: TellToolInput): Promise<{ message_id: string; delivered: true; job_id: string | null }> {
  const posted = context.bridge.post({
    from: 'claude',
    kind: 'note',
    text: input.message,
    thread: input.job_id,
  });

  return { message_id: posted.id, delivered: true, job_id: posted.thread };
}
