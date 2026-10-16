import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { DEFAULT_LEVELS } from '../../config/schema.ts';

import { listLibrary } from './library.ts';
import { GATE_RESULTS_DIR, LIBRARY_COMPONENT } from './result.ts';
import { removeStaleResults } from './stale-results.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const created: string[] = [];

/** A fresh sandbox under the repo's gitignored `.tmp/`, removed after the test. */
function sandbox(): string {
  const root = join(REPO_ROOT, '.tmp', `stale-results-${crypto.randomUUID()}`);

  created.push(root);
  mkdirSync(root, { recursive: true });

  return root;
}

/** Writes `content` to `<root>/<path>`, creating the folders it needs. */
function writeFile(root: string, path: string, content = ''): void {
  const target = join(root, path);

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/** Every file, folder and link under `root`, POSIX-relative to it, sorted. */
function snapshot(root: string): readonly string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map((path) => path
      .split('\\')
      .join('/'))
    .sort();
}

afterEach(() => {
  for (const path of created.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('removeStaleResults', () => {
  test('removes exactly the deleted component of a two-component library with three result folders', () => {
    const root = sandbox();
    const targetDir = join(root, 'library');

    writeFile(targetDir, 'src/atoms/Button/Button.tsx', 'export {};\n');
    writeFile(targetDir, 'src/molecules/Toolbar/Toolbar.tsx', 'export {};\n');
    writeFile(targetDir, 'tsconfig.json', '{}\n');
    writeFile(root, 'source/seed-manifest.json', '{}\n');

    for (const component of ['Button', 'Toolbar', 'Removed']) {
      writeFile(targetDir, `${GATE_RESULTS_DIR}/${component}/structure.json`, '{}\n');
    }

    const names = listLibrary(targetDir, DEFAULT_LEVELS).components.map((component) => component.name);
    const before = snapshot(root);

    const removed = removeStaleResults(targetDir, names);

    expect(names).toEqual(['Button', 'Toolbar']);
    expect(removed).toEqual(['Removed']);
    expect(readdirSync(join(targetDir, GATE_RESULTS_DIR)).sort()).toEqual(['Button', 'Toolbar']);
    expect(snapshot(root)).toEqual(before.filter((path) => !path.startsWith(`library/${GATE_RESULTS_DIR}/Removed`)));
    expect(before).toContain(`library/${GATE_RESULTS_DIR}/Removed/structure.json`);
  });

  test('removes nothing when gate-results is missing', () => {
    const root = sandbox();

    writeFile(root, 'src/atoms/Button/Button.tsx');

    const before = snapshot(root);

    expect(removeStaleResults(root, [])).toEqual([]);
    expect(snapshot(root)).toEqual(before);
  });

  test('keeps the _library folder and every held component', () => {
    const root = sandbox();

    writeFile(root, `${GATE_RESULTS_DIR}/${LIBRARY_COMPONENT}/build-lint.json`);
    writeFile(root, `${GATE_RESULTS_DIR}/Button/structure.json`);

    expect(removeStaleResults(root, ['Button'])).toEqual([]);
    expect(readdirSync(join(root, GATE_RESULTS_DIR)).sort()).toEqual(['Button', LIBRARY_COMPONENT]);
  });

  test('leaves files directly inside gate-results alone', () => {
    const root = sandbox();

    writeFile(root, `${GATE_RESULTS_DIR}/summary.json`, 'kept\n');
    writeFile(root, `${GATE_RESULTS_DIR}/Gone/structure.json`);

    expect(removeStaleResults(root, [])).toEqual(['Gone']);
    expect(readdirSync(join(root, GATE_RESULTS_DIR))).toEqual(['summary.json']);
    expect(readFileSync(join(root, GATE_RESULTS_DIR, 'summary.json'), 'utf8')).toBe('kept\n');
  });

  test('removes a stale symbolic link as a link, leaving its target untouched', () => {
    const root = sandbox();
    const outside = join(root, 'outside');

    writeFile(outside, 'structure.json', 'outside\n');
    mkdirSync(join(root, GATE_RESULTS_DIR));
    symlinkSync(outside, join(root, GATE_RESULTS_DIR, 'Linked'), 'dir');

    expect(removeStaleResults(root, [])).toEqual(['Linked']);
    expect(existsSync(join(root, GATE_RESULTS_DIR, 'Linked'))).toBe(false);
    expect(readFileSync(join(outside, 'structure.json'), 'utf8')).toBe('outside\n');
  });

  test('leaves a gate-results that is a symbolic link alone', () => {
    const root = sandbox();
    const outside = join(root, 'outside');

    writeFile(outside, 'Gone/structure.json');
    symlinkSync(outside, join(root, GATE_RESULTS_DIR), 'dir');

    expect(removeStaleResults(root, [])).toEqual([]);
    expect(existsSync(join(outside, 'Gone', 'structure.json'))).toBe(true);
  });

  test('returns the removed names sorted by code unit', () => {
    const root = sandbox();

    for (const component of ['beta', 'Zeta', 'Alpha']) {
      writeFile(root, `${GATE_RESULTS_DIR}/${component}/structure.json`);
    }

    expect(removeStaleResults(root, [])).toEqual(['Alpha', 'Zeta', 'beta']);
  });
});
