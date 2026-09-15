import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { toGitHubPackage, assertTagMatchesVersion } from '../../scripts/github-package.mjs';

const base = () => ({ name: 'mcp-server-codex', version: '0.1.0' });

describe('toGitHubPackage', () => {
  test('scopes the package to the repository owner', () => {
    assert.equal(toGitHubPackage(base(), 'acme').name, '@acme/mcp-server-codex');
  });

  test('lowercases the owner, because npm scopes cannot contain uppercase', () => {
    // GitHub owners keep their case; npm would reject "@MyOrg/...".
    assert.equal(toGitHubPackage(base(), 'MyOrg').name, '@myorg/mcp-server-codex');
  });

  test('points publishConfig at GitHub Packages', () => {
    const pkg = toGitHubPackage(base(), 'acme');
    assert.equal(pkg.publishConfig?.registry, 'https://npm.pkg.github.com');
    assert.equal(pkg.publishConfig?.access, 'restricted');
  });

  test('is idempotent, so re-running it in a retried job is harmless', () => {
    const once = toGitHubPackage(base(), 'acme');
    const twice = toGitHubPackage(once, 'acme');
    assert.equal(twice.name, '@acme/mcp-server-codex');
  });

  test('re-scopes a package already scoped to a different owner', () => {
    const forked = { name: '@original/mcp-server-codex', version: '0.1.0' };
    assert.equal(toGitHubPackage(forked, 'fork-owner').name, '@fork-owner/mcp-server-codex');
  });

  test('leaves the version untouched', () => {
    assert.equal(toGitHubPackage(base(), 'acme').version, '0.1.0');
  });

  test('sets the repository url when given one', () => {
    const pkg = toGitHubPackage(base(), 'acme', 'acme/mcp-server-codex');
    assert.equal(pkg.repository?.url, 'git+https://github.com/acme/mcp-server-codex.git');
  });

  test('refuses an empty owner rather than producing "@/name"', () => {
    assert.throws(() => toGitHubPackage(base(), ''), /owner/i);
  });

  test('does not mutate the object it was given', () => {
    const original = base();
    toGitHubPackage(original, 'acme');
    assert.equal(original.name, 'mcp-server-codex');
  });
});

describe('assertTagMatchesVersion', () => {
  test('accepts a tag that matches the manifest version', () => {
    assert.doesNotThrow(() => assertTagMatchesVersion('v1.2.3', '1.2.3'));
  });

  test('accepts a tag without the v prefix', () => {
    assert.doesNotThrow(() => assertTagMatchesVersion('1.2.3', '1.2.3'));
  });

  test('accepts a refs/tags ref, which is what GitHub actually passes', () => {
    assert.doesNotThrow(() => assertTagMatchesVersion('refs/tags/v1.2.3', '1.2.3'));
  });

  test('rejects a mismatch, naming both sides', () => {
    // Publishing v1.2.3 from a manifest saying 1.2.2 ships a mislabelled release.
    assert.throws(() => assertTagMatchesVersion('v1.2.3', '1.2.2'), /1\.2\.3.*1\.2\.2|1\.2\.2.*1\.2\.3/s);
  });

  test('rejects a prerelease tag that disagrees with the manifest', () => {
    assert.throws(() => assertTagMatchesVersion('v1.0.0-rc.1', '1.0.0'), /mismatch/i);
  });

  test('accepts a matching prerelease', () => {
    assert.doesNotThrow(() => assertTagMatchesVersion('v1.0.0-rc.1', '1.0.0-rc.1'));
  });
});
