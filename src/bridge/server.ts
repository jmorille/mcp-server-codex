/**
 * The Codex-facing half of the bridge.
 *
 * Codex spawns this as an MCP server of its own, so from Codex's point of view
 * Claude is just three tools. Everything it does goes through the shared
 * mailbox on disk; this process never talks to the Claude-side server directly.
 *
 * The one thing that makes the bridge feel synchronous is `ask_claude`, which
 * blocks the tool call while polling the mailbox. Blocking is safe here because
 * it always has a deadline and always hands back a `question_id`: a question
 * that times out is not lost, it is collected on a later turn with
 * `check_claude`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { openMailbox } from './mailbox.ts';
import type { Message } from './mailbox.ts';

export const BRIDGE_SERVER_NAME = 'claude-bridge';

/** What Codex sees when it lists this server among its own. */
export const BRIDGE_DESCRIPTION =
  'A direct line to the Claude agent supervising this run. Use it to get a decision you cannot make ' +
  'alone, to report something the supervisor should act on, and to pick up instructions it sent you ' +
  'mid-task. Messages are queued, so nothing is lost if either side is busy.';

/**
 * Why this is worth saying out loud.
 *
 * Left to itself a model guesses at an ambiguous requirement and finds out it
 * guessed wrong at the end. These instructions exist to make asking the
 * cheaper option, and to make clear that a slow answer is not a dead end.
 */
export const BRIDGE_INSTRUCTIONS = [
  'You are not working alone. A Claude agent is supervising this run and can answer questions ' +
    'while you work.',
  'Ask with ask_claude when a decision is genuinely not yours to make: an ambiguous requirement, a ' +
    'choice between approaches with real trade-offs, permission for something destructive or ' +
    'expensive, or a contradiction between what you were told and what the code does. One question ' +
    'costs seconds; guessing wrong costs the whole task.',
  'Do not ask for things you can find out yourself. Read the file, run the command, check the test.',
  'ask_claude blocks, but never forever. If it times out you get a question_id back instead of an ' +
    'error: keep going with whatever does not depend on the answer, then collect it later with ' +
    'check_claude. The question stays queued.',
  'Call check_claude between steps of anything long. The supervisor can send a correction or a stop ' +
    'without you having asked, and you will only see it when you look.',
  'Use tell_claude for things worth knowing but not worth waiting on: a finding, a surprise, a ' +
    'warning, progress on a long task.',
].join('\n\n');

export interface BridgeServerOptions {
  /** Directory both processes share. Created on first post. */
  mailboxDir: string;
  /** How long `ask_claude` blocks when the call does not say. */
  defaultTimeoutMs: number;
  /** How often the blocked call re-reads the mailbox. */
  pollMs?: number;
  /**
   * Identifies the run this bridge belongs to.
   *
   * One supervisor can drive several runs through a single mailbox. Stamping
   * it here is what keeps two concurrent runs from reading each other's mail,
   * and what lets Claude answer the right one. Left unset, the bridge sees
   * everything — which is only correct when there is exactly one run.
   */
  thread?: string;
}

function ok(text: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function messagePayload(message: Message): Record<string, unknown> {
  return {
    id: message.id,
    from: message.from,
    kind: message.kind,
    text: message.text,
    in_reply_to: message.in_reply_to,
    created_at: message.created_at,
  };
}

export function createBridgeServer(options: BridgeServerOptions): McpServer {
  const box = openMailbox(options.mailboxDir);
  const pollMs = options.pollMs ?? 250;
  const server = new McpServer(
    { name: BRIDGE_SERVER_NAME, version: '1', description: BRIDGE_DESCRIPTION },
    { instructions: BRIDGE_INSTRUCTIONS },
  );

  server.registerTool(
    'ask_claude',
    {
      title: 'Ask Claude',
      description:
        'Ask the Claude agent supervising this run a question and wait for its answer. Use this when a ' +
        'decision is genuinely the supervisor\'s to make — an ambiguous requirement, a choice between ' +
        'approaches, permission for something risky. If no answer arrives before the timeout the call ' +
        'returns a question_id instead of failing; collect the answer later with check_claude.',
      inputSchema: {
        question: z.string().min(1).describe('What you need decided. Include the context Claude needs to answer.'),
        timeout_seconds: z
          .number()
          .min(0)
          .optional()
          .describe('How long to wait inline. Defaults to the bridge setting. 0 returns immediately.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ question, timeout_seconds }) => {
      const timeoutMs = timeout_seconds !== undefined ? timeout_seconds * 1_000 : options.defaultTimeoutMs;
      const posted = box.post({ from: 'codex', kind: 'question', text: question, thread: options.thread });
      const answer = await box.waitForReply({ to: posted.id, timeoutMs, pollMs });

      if (answer === null) {
        return ok(
          `No answer within ${Math.round(timeoutMs / 1_000)}s. The question is queued as ${posted.id}; ` +
            'carry on with what you can do without it and call check_claude later to collect the answer.',
          { question_id: posted.id, answered: false, answer: null, timed_out: true },
        );
      }

      return ok(answer.text, {
        question_id: posted.id,
        answered: true,
        answer: answer.text,
        timed_out: false,
        answer_id: answer.id,
      });
    },
  );

  server.registerTool(
    'tell_claude',
    {
      title: 'Tell Claude',
      description:
        'Send the supervising Claude agent a message without waiting for a reply — progress, a finding, ' +
        'a warning it should act on. Returns as soon as the message is queued; Claude reads it on its ' +
        'next tool turn. Use ask_claude instead when you actually need an answer before continuing.',
      inputSchema: {
        message: z.string().min(1).describe('What to tell Claude.'),
        in_reply_to: z.string().optional().describe('Id of a Claude message this responds to, if any.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    ({ message, in_reply_to }) => {
      const kind = in_reply_to !== undefined ? 'answer' : 'note';
      const posted = box.post({ from: 'codex', kind, text: message, inReplyTo: in_reply_to, thread: options.thread });

      return ok(`Queued for Claude as ${posted.id}.`, { message_id: posted.id, delivered: true });
    },
  );

  server.registerTool(
    'check_claude',
    {
      title: 'Check for messages from Claude',
      description:
        'Read anything the supervising Claude agent has sent since the last check, including messages it ' +
        'sent unprompted — a correction, a change of direction, a stop. Pass question_id to also collect ' +
        'the answer to an earlier ask_claude that timed out. Cheap and non-blocking; worth calling between ' +
        'steps of a long task.',
      inputSchema: {
        since: z.number().int().min(0).optional().describe('next_cursor from a previous call. Omit to read from the start.'),
        question_id: z.string().optional().describe('Also report whether this earlier question has been answered.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    ({ since, question_id }) => {
      const page = box.read({ audience: 'codex', since, thread: options.thread });
      const payload: Record<string, unknown> = {
        messages: page.messages.map(messagePayload),
        next_cursor: page.nextCursor,
        count: page.messages.length,
      };

      if (question_id !== undefined) {
        // Not restricted to the page: an answer posted before `since` is still
        // the answer, and losing it to a cursor would strand the question.
        const everything = box.read({ audience: 'codex', thread: options.thread }).messages;
        const answer = everything.find((m) => m.in_reply_to === question_id);
        payload.question_id = question_id;
        payload.answered = answer !== undefined;
        payload.answer = answer?.text ?? null;
      }

      const summary =
        page.messages.length === 0
          ? 'Nothing new from Claude.'
          : page.messages.map((m) => `[${m.kind}] ${m.text}`).join('\n');

      return ok(summary, payload);
    },
  );

  return server;
}
