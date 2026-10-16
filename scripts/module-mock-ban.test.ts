/**
 * The module-mock ban. Bun's `vi` shim has no `vi.doUnmock` and no
 * `vi.resetModules`, so a test file that calls either cannot run under both
 * `bun test` and vitest. This check fails when any `*.test.ts` file in the
 * repo, other than this one, calls either. A test that needs a different value
 * from a dependency takes it as a parameter whose default is the real value.
 *
 * @packageDocumentation
 */

import { globSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import { describe, expect, test } from 'vitest';

/** The repo root, which every path in this check is POSIX-relative to. */
const REPO_ROOT = join(import.meta.dirname, '..');

/** This file's path, POSIX-relative to the repo root, derived so a rename keeps the exclusion right. */
const OWN_PATH = posix.relative(
  REPO_ROOT.split('\\').join('/'),
  import.meta.filename.split('\\').join('/'),
);

/** The `vi` members Bun's shim lacks. */
const BANNED_NAMES: readonly string[] = ['doUnmock', 'resetModules'];

/** A call of a banned `vi` member, capturing its name. */
const BANNED_CALL = new RegExp(`\\bvi\\.(${BANNED_NAMES.join('|')})\\s*\\(`, 'g');

/** A test file's path, POSIX-relative to the repo root, and its text. */
interface TestSource {
  readonly path: string;
  readonly text: string;
}

/** One banned call: the file, the 1-based line and the member called. */
interface BannedCall {
  readonly path: string;
  readonly line: number;
  readonly name: string;
}

/** Every banned call in one file's text, in line order. */
function findBannedCallsInFile({ path, text }: TestSource): readonly BannedCall[] {
  const found: BannedCall[] = [];

  text.split('\n').forEach((lineText, index) => {
    for (const match of lineText.matchAll(BANNED_CALL)) {
      found.push({ path, line: index + 1, name: match[1] ?? '' });
    }
  });

  return found;
}

/** Every banned call in `sources`, in file then line order. */
function findBannedCalls(sources: readonly TestSource[]): readonly BannedCall[] {
  return sources.flatMap(findBannedCallsInFile);
}

/** One `path:line: vi.<name>` entry per banned call. */
function describeBanned(found: readonly BannedCall[]): readonly string[] {
  return found.map(({ path, line, name }) => `${path}:${line}: vi.${name}`);
}

/** Every `*.test.ts` file in the repo outside `node_modules`, read from disk. */
function readRepoTestPaths(): readonly string[] {
  return globSync('**/*.test.ts', {
    cwd: REPO_ROOT,
    exclude: (name: string) => posix.basename(name) === 'node_modules',
  }).map((path) => path.split('\\').join('/'));
}

describe('findBannedCalls', () => {
  test('flags a vi.doUnmock call and a vi.resetModules call with file and line', () => {
    const sources = [{
      path: 'pipeline/example.test.ts',
      text: [
        'import { vi } from \'vitest\';',
        'vi.doUnmock(\'./dep.ts\');',
        '',
        'beforeEach(() => { vi.resetModules(); });',
      ].join('\n'),
    }];

    expect(describeBanned(findBannedCalls(sources))).toEqual([
      'pipeline/example.test.ts:2: vi.doUnmock',
      'pipeline/example.test.ts:4: vi.resetModules',
    ]);
  });

  test('ignores text without either call', () => {
    const sources = [{
      path: 'pipeline/example.test.ts',
      text: [
        'import { vi } from \'vitest\';',
        'vi.mock(\'./dep.ts\');',
        'vi.fn();',
        'const resetModulesLater = 1;',
        'notvi.resetModules();',
      ].join('\n'),
    }];

    expect(findBannedCalls(sources)).toEqual([]);
  });
});

describe('the repo\'s test files', () => {
  test('are scanned, reaching pipeline/assess/discover.test.ts and not node_modules or this file', () => {
    const paths = readRepoTestPaths().filter((path) => path !== OWN_PATH);

    expect(paths).toContain('pipeline/assess/discover.test.ts');
    expect(paths).not.toContain(OWN_PATH);
    expect(paths.some((path) => path.includes('node_modules'))).toBe(false);
  });

  test('call neither vi.doUnmock nor vi.resetModules', () => {
    const sources = readRepoTestPaths()
      .filter((path) => path !== OWN_PATH)
      .map((path) => ({ path, text: readFileSync(join(REPO_ROOT, path), 'utf8') }));

    expect(describeBanned(findBannedCalls(sources))).toEqual([]);
  });
});
