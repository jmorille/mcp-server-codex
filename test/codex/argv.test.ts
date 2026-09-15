import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildExecArgs,
  buildResumeArgs,
  buildForkArgs,
  buildReviewArgs,
  buildApplyArgs,
  ArgvError,
} from '../../src/codex/argv.ts';

describe('buildExecArgs', () => {
  test('emits the minimal non-interactive invocation', () => {
    assert.deepEqual(buildExecArgs({ prompt: 'hello' }), [
      'exec',
      '--json',
      '-c',
      'approval_policy="never"',
      '-s',
      'workspace-write',
      '-',
    ]);
  });

  test('passes the prompt through stdin rather than argv', () => {
    const args = buildExecArgs({ prompt: 'a very long prompt '.repeat(1000) });
    assert.ok(!args.some((a) => a.includes('very long prompt')), 'prompt must never reach argv');
    assert.equal(args.at(-1), '-');
  });

  test('renders every optional flag', () => {
    const args = buildExecArgs({
      prompt: 'go',
      model: 'gpt-5.5',
      sandbox: 'read-only',
      profile: 'work',
      addDirs: ['/a', '/b'],
      images: ['/img1.png', '/img2.png'],
      config: ['model_reasoning_effort="high"'],
      enable: ['image_generation'],
      disable: ['hooks'],
      outputSchema: '/schema.json',
      outputLastMessage: '/last.txt',
      worktree: true,
      ephemeral: true,
      skipGitRepoCheck: true,
    });

    assert.deepEqual(args, [
      'exec',
      '--json',
      '-c',
      'approval_policy="never"',
      '-c',
      'model_reasoning_effort="high"',
      '-s',
      'read-only',
      '-m',
      'gpt-5.5',
      '-p',
      'work',
      '--add-dir',
      '/a',
      '--add-dir',
      '/b',
      '-i',
      '/img1.png',
      '-i',
      '/img2.png',
      '--enable',
      'image_generation',
      '--disable',
      'hooks',
      '--output-schema',
      '/schema.json',
      '-o',
      '/last.txt',
      '--worktree',
      '--ephemeral',
      '--skip-git-repo-check',
      '-',
    ]);
  });

  test('renders the bypass flag only when explicitly asked', () => {
    assert.ok(!buildExecArgs({ prompt: 'x' }).includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(
      buildExecArgs({ prompt: 'x', dangerouslyBypassApprovalsAndSandbox: true }).includes(
        '--dangerously-bypass-approvals-and-sandbox',
      ),
    );
  });

  test('rejects an empty prompt', () => {
    assert.throws(() => buildExecArgs({ prompt: '   ' }), ArgvError);
  });
});

describe('buildResumeArgs', () => {
  test('resumes a session by id', () => {
    assert.deepEqual(buildResumeArgs({ sessionId: 'abc-123', prompt: 'continue' }), [
      'exec',
      'resume',
      '--json',
      '-c',
      'approval_policy="never"',
      '-c',
      'sandbox_mode="workspace-write"',
      'abc-123',
      '-',
    ]);
  });

  test('resumes the most recent session with --last instead of an id', () => {
    const args = buildResumeArgs({ last: true, prompt: 'continue' });
    assert.ok(args.includes('--last'));
    assert.equal(args.at(-1), '-');
  });

  test('routes the sandbox through -c because resume has no -s flag', () => {
    const args = buildResumeArgs({ sessionId: 'x', sandbox: 'read-only', prompt: 'p' });
    assert.ok(!args.includes('-s'), 'codex exec resume does not accept -s');
    assert.ok(args.includes('sandbox_mode="read-only"'));
  });

  test('omits the stdin marker when no prompt is given', () => {
    assert.equal(buildResumeArgs({ sessionId: 'x' }).at(-1), 'x');
  });

  test('rejects being given neither a session id nor --last', () => {
    assert.throws(() => buildResumeArgs({ prompt: 'p' }), /session_id.*last|last.*session_id/i);
  });

  test('rejects being given both a session id and --last', () => {
    assert.throws(() => buildResumeArgs({ sessionId: 'x', last: true, prompt: 'p' }), ArgvError);
  });
});

describe('buildForkArgs', () => {
  test('forks a session by id', () => {
    const args = buildForkArgs({ sessionId: 'abc-123', prompt: 'branch off' });
    assert.deepEqual(args.slice(0, 3), ['exec', 'fork', '--json']);
    assert.deepEqual(args.slice(-2), ['abc-123', '-']);
  });

  test('requires a session id', () => {
    assert.throws(() => buildForkArgs({ sessionId: '', prompt: 'p' }), ArgvError);
  });
});

describe('buildReviewArgs', () => {
  test('uses codex exec review, the only review path that speaks --json', () => {
    assert.deepEqual(buildReviewArgs({ uncommitted: true }).slice(0, 3), ['exec', 'review', '--json']);
  });

  test('renders each review target', () => {
    assert.ok(buildReviewArgs({ uncommitted: true }).includes('--uncommitted'));
    assert.deepEqual(buildReviewArgs({ base: 'main' }).slice(-2), ['--base', 'main']);
    assert.deepEqual(buildReviewArgs({ commit: 'deadbeef' }).slice(-2), ['--commit', 'deadbeef']);
  });

  test('rejects two review targets at once', () => {
    assert.throws(() => buildReviewArgs({ uncommitted: true, base: 'main' }), ArgvError);
  });

  test('appends the stdin marker only when custom instructions are given', () => {
    assert.ok(!buildReviewArgs({ uncommitted: true }).includes('-'));
    assert.equal(buildReviewArgs({ uncommitted: true, prompt: 'focus on races' }).at(-1), '-');
  });

  test('carries the title through', () => {
    assert.ok(buildReviewArgs({ uncommitted: true, title: 'PR 42' }).includes('PR 42'));
  });
});

describe('buildApplyArgs', () => {
  test('applies a task diff', () => {
    assert.deepEqual(buildApplyArgs({ taskId: 'task-7' }), ['apply', 'task-7']);
  });

  test('requires a task id', () => {
    assert.throws(() => buildApplyArgs({ taskId: '' }), ArgvError);
  });
});
