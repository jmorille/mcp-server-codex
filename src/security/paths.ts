import fs from 'node:fs';
import path from 'node:path';

/**
 * Raised when a caller-supplied path escapes the configured allowlist.
 *
 * The message deliberately names both the offending path and the allowed
 * roots: the consumer is an LLM agent, and a diagnosable error lets it
 * correct its own call instead of retrying blindly.
 */
export class PathViolationError extends Error {
  readonly candidate: string;
  readonly roots: readonly string[];

  constructor(candidate: string, roots: readonly string[]) {
    super(
      `Path "${candidate}" is outside the allowed roots. ` +
        `Allowed roots: ${roots.join(', ')}. ` +
        `Set CODEX_MCP_ALLOWED_ROOTS to widen this allowlist.`,
    );
    this.name = 'PathViolationError';
    this.candidate = candidate;
    this.roots = roots;
  }
}

export interface PathPolicy {
  /** Allowed roots, absolute and symlink-resolved. */
  readonly roots: readonly string[];
  /**
   * Resolve `candidate` to an absolute, symlink-resolved path and assert it
   * lives under one of the roots. Relative paths resolve against the first
   * root — never against `process.cwd()`, which the MCP client does not
   * control and cannot reason about.
   *
   * @throws {PathViolationError} when the resolved path escapes every root.
   */
  resolve(candidate: string): string;
}

/**
 * Resolve symlinks as far as the filesystem allows, then re-append the
 * segments that do not exist yet.
 *
 * Resolving only the existing prefix is what makes the check safe for paths
 * being created (an image destination, a new worktree) while still defeating
 * a symlinked ancestor that points outside the allowlist.
 */
function resolveRealpath(target: string): string {
  const absolute = path.resolve(target);
  const missingSegments: string[] = [];
  let current = absolute;

  for (;;) {
    try {
      const real = fs.realpathSync(current);
      if (missingSegments.length === 0) return real;
      return path.join(real, ...missingSegments.slice().reverse());
    } catch {
      const parent = path.dirname(current);
      // Reached the filesystem root without finding anything that exists.
      if (parent === current) return absolute;
      missingSegments.push(path.basename(current));
      current = parent;
    }
  }
}

function forComparison(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function isWithin(child: string, parent: string): boolean {
  const c = forComparison(path.resolve(child));
  const p = forComparison(path.resolve(parent));
  if (c === p) return true;
  // The separator guard stops "/srv/work-evil" from passing as "/srv/work".
  const prefix = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(prefix);
}

export function createPathPolicy(roots: readonly string[]): PathPolicy {
  if (roots.length === 0) {
    throw new Error('A path policy needs at least one root directory.');
  }
  for (const root of roots) {
    if (!path.isAbsolute(root)) {
      throw new Error(`Root "${root}" must be an absolute path.`);
    }
  }

  const resolvedRoots = roots.map((root) => resolveRealpath(root));
  const primaryRoot = resolvedRoots[0] as string;

  return {
    roots: resolvedRoots,
    resolve(candidate: string): string {
      const absolute = path.isAbsolute(candidate)
        ? candidate
        : path.resolve(primaryRoot, candidate);
      const real = resolveRealpath(absolute);

      if (resolvedRoots.some((root) => isWithin(real, root))) return real;
      throw new PathViolationError(candidate, resolvedRoots);
    },
  };
}
