import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { isInside, readRelativeImports } from './imports.ts';

const dirs: string[] = [];

/** A temp library holding `text` at `file`, and its root. */
function tempFile(file: string, text: string): string {
  const targetDir = mkdtempSync(join(tmpdir(), 'd2c-imports-'));

  dirs.push(targetDir);
  mkdirSync(dirname(join(targetDir, file)), { recursive: true });
  writeFileSync(join(targetDir, file), text);

  return targetDir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('readRelativeImports', () => {
  test('reads relative imports, re-exports and literal dynamic imports, resolved, with the line each starts on', () => {
    const file = 'src/atoms/Button/Button.tsx';
    const targetDir = tempFile(file, [
      'import { useState } from \'react\';',
      'import { cn } from \'@/lib/cn\';',
      'import type {',
      '  Icon,',
      '} from \'../Icon/Icon\';',
      'export * from \'./parts\';',
      'export const load = () => import(`../../lib/cn`);',
      'export const dynamic = (name: string) => import(name);',
      'import \'..\';',
    ].join('\n'));

    expect(readRelativeImports(targetDir, file)).toEqual([
      { specifier: '../Icon/Icon', target: 'src/atoms/Icon/Icon', line: 3 },
      { specifier: './parts', target: 'src/atoms/Button/parts', line: 6 },
      { specifier: '../../lib/cn', target: 'src/lib/cn', line: 7 },
      { specifier: '..', target: 'src/atoms', line: 9 },
    ]);
  });

  test('reads nothing from a file that is not a script', () => {
    const file = 'src/atoms/Button/Button.css';

    expect(readRelativeImports(tempFile(file, '@import \'../x.css\';\n'), file)).toEqual([]);
  });

  test('throws when the file cannot be read', () => {
    expect(() => readRelativeImports(tempFile('a.ts', ''), 'missing.ts')).toThrow(/ENOENT/u);
  });
});

describe('isInside', () => {
  test('holds for the folder itself and paths under it, not for a sibling sharing its prefix', () => {
    expect(isInside('src/atoms', 'src/atoms')).toBe(true);
    expect(isInside('src/atoms/Button/Button', 'src/atoms')).toBe(true);
    expect(isInside('src/atomsExtra/Button', 'src/atoms')).toBe(false);
  });
});
