import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { DEFAULT_LEVELS } from '../../config/schema.ts';

import { LIBRARY_SOURCE_DIR, listLibrary } from './library.ts';

const dirs: string[] = [];

function tempTargetDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'd2c-gate-library-'));

  dirs.push(dir);

  return dir;
}

/** Writes an empty file at each POSIX path, relative to `targetDir`. */
function writeFiles(targetDir: string, paths: readonly string[]): void {
  for (const path of paths) {
    const absolute = join(targetDir, path);

    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, '');
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('listLibrary', () => {
  test('lists each component folder with its level, dir and sorted files, and counts them', () => {
    const targetDir = tempTargetDir();

    writeFiles(targetDir, [
      'src/atoms/Button/Button.variants.ts',
      'src/atoms/Button/Button.tsx',
      'src/atoms/Button/Button.stories.tsx',
      'src/molecules/Card/Card.tsx',
      'src/molecules/Card/parts/CardHeader.tsx',
    ]);

    const library = listLibrary(targetDir, DEFAULT_LEVELS);

    expect(LIBRARY_SOURCE_DIR).toBe('src');
    expect(library).toEqual({
      components: [
        {
          name: 'Button',
          level: 'atoms',
          dir: 'src/atoms/Button',
          files: [
            'src/atoms/Button/Button.stories.tsx',
            'src/atoms/Button/Button.tsx',
            'src/atoms/Button/Button.variants.ts',
          ],
        },
        {
          name: 'Card',
          level: 'molecules',
          dir: 'src/molecules/Card',
          files: ['src/molecules/Card/Card.tsx', 'src/molecules/Card/parts/CardHeader.tsx'],
        },
      ],
      scannedFiles: 5,
    });
  });

  test('orders components by the levels list, lowest first, then by name', () => {
    const targetDir = tempTargetDir();

    writeFiles(targetDir, [
      'src/organisms/Header/Header.tsx',
      'src/atoms/Input/Input.tsx',
      'src/atoms/Badge/Badge.tsx',
      'src/particles/Dot/Dot.tsx',
    ]);

    const order = listLibrary(targetDir, DEFAULT_LEVELS).components.map(({ level, name }) => `${level}/${name}`);

    expect(order).toEqual(['particles/Dot', 'atoms/Badge', 'atoms/Input', 'organisms/Header']);
  });

  test('reads the level folders the levels list names, and ignores the defaults it renames', () => {
    const targetDir = tempTargetDir();

    writeFiles(targetDir, [
      'src/base/Button/Button.tsx',
      'src/composite/Card/Card.tsx',
      'src/atoms/Ignored/Ignored.tsx',
    ]);

    const library = listLibrary(targetDir, ['base', 'composite']);

    expect(library.components.map(({ level, name }) => `${level}/${name}`)).toEqual(['base/Button', 'composite/Card']);
    expect(library.scannedFiles).toBe(2);
  });

  test('lists a component folder lacking <Name>.tsx, so a gate can report it', () => {
    const targetDir = tempTargetDir();

    writeFiles(targetDir, ['src/atoms/Button/index.ts']);
    mkdirSync(join(targetDir, 'src/atoms/Empty'), { recursive: true });

    expect(listLibrary(targetDir, DEFAULT_LEVELS).components).toEqual([
      { name: 'Button', level: 'atoms', dir: 'src/atoms/Button', files: ['src/atoms/Button/index.ts'] },
      { name: 'Empty', level: 'atoms', dir: 'src/atoms/Empty', files: [] },
    ]);
  });

  test('skips files loose in a level folder and folders outside the levels, such as pages/', () => {
    const targetDir = tempTargetDir();

    writeFiles(targetDir, ['src/atoms/index.ts', 'src/pages/Home/Home.tsx', 'src/lib/cn.ts', 'src/index.ts']);

    expect(listLibrary(targetDir, DEFAULT_LEVELS)).toEqual({ components: [], scannedFiles: 0 });
  });

  test('scans zero files in an empty target dir, a missing one, and a src that is a file', () => {
    const empty = tempTargetDir();
    const srcIsFile = tempTargetDir();

    writeFiles(srcIsFile, ['src']);

    expect(listLibrary(empty, DEFAULT_LEVELS)).toEqual({ components: [], scannedFiles: 0 });
    expect(listLibrary(join(empty, 'missing'), DEFAULT_LEVELS)).toEqual({ components: [], scannedFiles: 0 });
    expect(listLibrary(srcIsFile, DEFAULT_LEVELS)).toEqual({ components: [], scannedFiles: 0 });
  });

  test('skips symbolic links, so the scan never leaves the target dir', () => {
    const targetDir = tempTargetDir();
    const outside = tempTargetDir();

    writeFiles(outside, ['Secret/Secret.tsx', 'secret.ts']);
    writeFiles(targetDir, ['src/atoms/Button/Button.tsx']);
    symlinkSync(join(outside, 'Secret'), join(targetDir, 'src/atoms/Secret'));
    symlinkSync(join(outside, 'secret.ts'), join(targetDir, 'src/atoms/Button/secret.ts'));

    expect(listLibrary(targetDir, DEFAULT_LEVELS)).toEqual({
      components: [
        { name: 'Button', level: 'atoms', dir: 'src/atoms/Button', files: ['src/atoms/Button/Button.tsx'] },
      ],
      scannedFiles: 1,
    });
  });

  test.each(['..', '.', '', 'atoms/nested', '..\\up'])('refuses the level %j, which is not one folder name', (level) => {
    const targetDir = tempTargetDir();

    expect(() => listLibrary(targetDir, ['atoms', level])).toThrow('is not a single folder name');
  });
});
