/**
 * Integration test for the `test` script of `templates/library`, run in a
 * fresh copy the way a seeded library runs it.
 *
 * The template is copied into a folder under the repo's gitignored `.tmp/`,
 * so `vitest` and the template's dependencies resolve from the repo's
 * `node_modules` without a network install. Its `test` script runs there as
 * a child process and must exit 0 and name `cn.test.ts`. The copy is removed
 * afterwards, even if an assertion fails.
 *
 * @packageDocumentation
 */

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

/** The longest the copied template's test run may take. */
const RUN_TIMEOUT_MS = 120_000;

const TEMPLATE_DIR = import.meta.dirname;
const TMP_ROOT = join(TEMPLATE_DIR, '..', '..', '.tmp');

/** Files the copy leaves out: installed packages, and this test itself, which must not run inside the copy. */
const isCopied = (source: string): boolean => (
  basename(source) !== 'node_modules' && !source.endsWith('.integration.test.ts')
);

let copyDir: string | undefined;

afterEach(() => {
  if (copyDir !== undefined) {
    rmSync(copyDir, { recursive: true, force: true });
    copyDir = undefined;
  }
});

test(
  'the template test script exits 0 and runs cn.test.ts in a fresh copy',
  () => {
    // Arrange
    mkdirSync(TMP_ROOT, { recursive: true });
    copyDir = mkdtempSync(join(TMP_ROOT, 'template-test-script-'));
    cpSync(TEMPLATE_DIR, copyDir, { recursive: true, filter: isCopied });

    // Act
    const { status, stdout, stderr } = spawnSync('bun', ['run', 'test', '--reporter=verbose'], {
      cwd: copyDir,
      encoding: 'utf8',
      env: { ...process.env, CI: '1', NO_COLOR: '1' },
    });

    // Assert
    expect(status, `${stdout}\n${stderr}`).toBe(0);
    expect(`${stdout}\n${stderr}`).toContain('cn.test.ts');
  },
  RUN_TIMEOUT_MS,
);
