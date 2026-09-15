/**
 * Session discovery, read straight from disk.
 *
 * `codex resume` without an id opens a TUI picker, which an MCP server can
 * never drive. Codex does persist everything needed on disk though, so listing
 * is a filesystem job:
 *
 * - `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` — one file per session,
 *   whose first line is a `session_meta` header. This is the authoritative set.
 * - `$CODEX_HOME/session_index.jsonl` — only holds *named* threads, so it is an
 *   enrichment source (name, updated_at), never the source of truth.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

export interface SessionInfo {
  id: string;
  name: string | null;
  updatedAt: string | null;
  cwd: string | null;
  cliVersion: string | null;
  source: string | null;
  modelProvider: string | null;
  rolloutPath: string | null;
}

export interface ListSessionsOptions {
  codexHome: string;
  limit?: number;
  /** Keep only sessions whose working directory matches. */
  cwd?: string;
  /** Case-insensitive substring match on the thread name. */
  query?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Read just the first line of a file.
 *
 * Rollouts hold the full transcript and routinely reach tens of megabytes;
 * reading one in full to list it would make the tool unusable.
 */
async function readFirstLine(filePath: string): Promise<string | null> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  try {
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) return line;
      return null;
    } finally {
      lines.close();
    }
  } finally {
    stream.destroy();
  }
}

async function readRolloutHeader(filePath: string): Promise<SessionInfo | null> {
  let line: string | null;
  try {
    line = await readFirstLine(filePath);
  } catch {
    return null;
  }
  if (line === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.type !== 'session_meta') return null;
  if (!isRecord(parsed.payload)) return null;

  const payload = parsed.payload;
  const id = asString(payload.session_id) ?? asString(payload.id);
  if (id === null) return null;

  return {
    id,
    name: null,
    updatedAt: asString(payload.timestamp) ?? asString(parsed.timestamp),
    cwd: asString(payload.cwd),
    cliVersion: asString(payload.cli_version),
    source: asString(payload.source),
    modelProvider: asString(payload.model_provider),
    rolloutPath: filePath,
  };
}

/** Walk `sessions/YYYY/MM/DD` without assuming the depth is exactly three. */
async function findRolloutFiles(sessionsDir: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(sessionsDir, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl'))
    .map((entry) => path.join(entry.parentPath ?? sessionsDir, entry.name));
}

/** Thread names and update times for the subset of sessions that were named. */
async function readIndex(codexHome: string): Promise<Map<string, { name: string | null; updatedAt: string | null }>> {
  const byId = new Map<string, { name: string | null; updatedAt: string | null }>();

  let content: string;
  try {
    content = await fsp.readFile(path.join(codexHome, 'session_index.jsonl'), 'utf8');
  } catch {
    return byId;
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // A truncated or half-written line must not sink the whole listing.
      continue;
    }
    if (!isRecord(parsed)) continue;

    const id = asString(parsed.id);
    if (id === null) continue;
    byId.set(id, {
      name: asString(parsed.thread_name),
      updatedAt: asString(parsed.updated_at),
    });
  }

  return byId;
}

export async function listSessions(options: ListSessionsOptions): Promise<SessionInfo[]> {
  const sessionsDir = path.join(options.codexHome, 'sessions');
  const [files, index] = await Promise.all([findRolloutFiles(sessionsDir), readIndex(options.codexHome)]);

  const headers = await Promise.all(files.map((file) => readRolloutHeader(file)));

  const sessions: SessionInfo[] = [];
  for (const header of headers) {
    if (header === null) continue;
    const enrichment = index.get(header.id);
    sessions.push({
      ...header,
      name: enrichment?.name ?? header.name,
      updatedAt: enrichment?.updatedAt ?? header.updatedAt,
    });
  }

  const cwdFilter = options.cwd ? path.resolve(options.cwd).toLowerCase() : null;
  const queryFilter = options.query ? options.query.toLowerCase() : null;

  const filtered = sessions.filter((session) => {
    if (cwdFilter !== null) {
      if (session.cwd === null) return false;
      if (path.resolve(session.cwd).toLowerCase() !== cwdFilter) return false;
    }
    if (queryFilter !== null) {
      const haystack = `${session.name ?? ''} ${session.id}`.toLowerCase();
      if (!haystack.includes(queryFilter)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));

  return options.limit !== undefined ? filtered.slice(0, options.limit) : filtered;
}
