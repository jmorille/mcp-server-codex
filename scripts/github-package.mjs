#!/usr/bin/env node
/**
 * Prepare package.json for publication to GitHub Packages.
 *
 * GitHub Packages only accepts a package scoped to the owning account, so the
 * published name has to be `@owner/mcp-server-codex`. Rather than hard-coding
 * one owner in the repository — which would break every fork — the scope is
 * derived at publish time from `github.repository_owner`.
 *
 * Used as a CLI by the release workflow:
 *   node scripts/github-package.mjs <owner> [<owner/repo>] [<tag>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTRY = 'https://npm.pkg.github.com';

/** Strip an existing scope so a fork can re-scope a package it inherited. */
function unscopedName(name) {
  return name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name;
}

/**
 * @param {Record<string, any>} pkg parsed package.json
 * @param {string} owner GitHub account or organisation
 * @param {string} [repository] "owner/repo", to fill the repository field
 * @returns {Record<string, any>} a new manifest; the input is left alone
 */
export function toGitHubPackage(pkg, owner, repository) {
  if (typeof owner !== 'string' || owner.trim() === '') {
    throw new Error('A GitHub owner is required to scope the package.');
  }

  // GitHub preserves the case of account names; npm scopes must be lowercase,
  // and npm rejects the manifest outright rather than normalising it.
  const scope = owner.trim().toLowerCase();

  const next = { ...pkg, name: `@${scope}/${unscopedName(pkg.name)}` };

  next.publishConfig = {
    ...pkg.publishConfig,
    registry: REGISTRY,
    // GitHub Packages has no public tier for npm; "restricted" states the
    // truth rather than letting npm default to something misleading.
    access: 'restricted',
  };

  if (repository) {
    next.repository = { type: 'git', url: `git+https://github.com/${repository}.git` };
    next.homepage = `https://github.com/${repository}#readme`;
    next.bugs = { url: `https://github.com/${repository}/issues` };
  }

  return next;
}

/**
 * Refuse to publish when the tag and the manifest disagree.
 *
 * Without this, pushing `v1.2.3` against a manifest still saying `1.2.2` ships
 * a release whose label lies about its contents — and npm versions cannot be
 * republished, so the mistake is permanent.
 */
export function assertTagMatchesVersion(tag, version) {
  const normalised = String(tag).replace(/^refs\/tags\//, '').replace(/^v/, '');
  if (normalised !== version) {
    throw new Error(
      `Version mismatch: tag "${tag}" resolves to ${normalised}, but package.json says ${version}. ` +
        'Bump the manifest or retag.',
    );
  }
}

/** CLI entry point; no-op when the module is merely imported by the tests. */
function main(argv) {
  const [owner, repository, tag] = argv;
  const manifestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  if (tag) assertTagMatchesVersion(tag, pkg.version);

  const next = toGitHubPackage(pkg, owner, repository);
  fs.writeFileSync(manifestPath, JSON.stringify(next, null, 2) + '\n');

  process.stdout.write(`${next.name}@${next.version} -> ${REGISTRY}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
