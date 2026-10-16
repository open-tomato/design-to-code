import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { DEFAULT_LEVELS } from '../../../../config/schema.ts';
import { listLibrary } from '../../library.ts';
import { gateFindingSchema } from '../../result.ts';

import { LAYER_IMPORTS_RULE, layerImports } from './layer-imports.ts';

const FIXTURE_DIR = resolve(import.meta.dirname, '../../fixtures/structure/layer-imports');
const dirs: string[] = [];

/** Runs the rule over the library at `targetDir`, read with `levels`. */
function run(targetDir: string, levels: readonly string[] = DEFAULT_LEVELS) {
  return layerImports({ targetDir, levels, components: listLibrary(targetDir, levels).components });
}

/** A temp library holding each file of `files`, keyed by POSIX path relative to it. */
function tempLibrary(files: Readonly<Record<string, string>>): string {
  const targetDir = mkdtempSync(join(tmpdir(), 'd2c-layer-imports-'));

  dirs.push(targetDir);

  for (const [path, text] of Object.entries(files)) {
    const absolute = join(targetDir, path);

    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
  }

  return targetDir;
}

/** The `file:line` of each finding, for compact assertions. */
function places(targetDir: string, levels: readonly string[] = DEFAULT_LEVELS): readonly string[] {
  return run(targetDir, levels).map(({ finding }) => `${finding.file}:${finding.line}`);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('layerImports over the fixtures', () => {
  test('the failing fixture yields an own-level and a higher-level finding, naming file and line', () => {
    const findings = run(join(FIXTURE_DIR, 'failing'));

    expect(findings).toEqual([
      {
        component: 'Button',
        finding: {
          rule: LAYER_IMPORTS_RULE,
          file: 'src/atoms/Button/Button.tsx',
          line: 3,
          message: 'Button (atoms) imports \'../Icon/Icon\' from its own level, atoms; '
            + 'a component imports only from components in lower levels',
        },
      },
      {
        component: 'Card',
        finding: {
          rule: LAYER_IMPORTS_RULE,
          file: 'src/molecules/Card/Card.tsx',
          line: 2,
          message: 'Card (molecules) imports \'../../organisms/Header/Header\' from a higher level, organisms; '
            + 'a component imports only from components in lower levels',
        },
      },
    ]);
    expect(LAYER_IMPORTS_RULE).toBe('layer-imports');

    for (const { finding } of findings) {
      expect(gateFindingSchema.parse(finding)).toEqual(finding);
    }
  });

  test('the passing fixture yields no finding while its library holds scanned files', () => {
    const targetDir = join(FIXTURE_DIR, 'passing');

    expect(listLibrary(targetDir, DEFAULT_LEVELS).scannedFiles).toBe(4);
    expect(run(targetDir)).toEqual([]);
  });
});

describe('layerImports', () => {
  test('reads type imports, re-exports, export-star and literal dynamic imports', () => {
    const targetDir = tempLibrary({
      'src/atoms/Low/Low.tsx': [
        'import type { High } from \'../../molecules/High/High\';',
        'export { High } from \'../../molecules/High/High\';',
        'export * from \'../../molecules/High/High\';',
        'export const load = () => import(\'../../molecules/High/High\');',
        'export const later = () => import(`../../molecules/High/High`);',
      ].join('\n'),
      'src/molecules/High/High.tsx': 'export const High = 1;\n',
    });

    expect(places(targetDir)).toEqual([
      'src/atoms/Low/Low.tsx:1',
      'src/atoms/Low/Low.tsx:2',
      'src/atoms/Low/Low.tsx:3',
      'src/atoms/Low/Low.tsx:4',
      'src/atoms/Low/Low.tsx:5',
    ]);
  });

  test('flags an import of a file directly in a level folder, such as a barrel, and of a level folder itself', () => {
    const targetDir = tempLibrary({
      'src/atoms/Button/Button.tsx': [
        'import { a } from \'../index\';',
        'import { b } from \'..\';',
        'import { c } from \'../../molecules\';',
        'import { d } from \'../../particles\';',
      ].join('\n'),
    });

    expect(places(targetDir)).toEqual(['src/atoms/Button/Button.tsx:1', 'src/atoms/Button/Button.tsx:2', 'src/atoms/Button/Button.tsx:3']);
  });

  test('ignores packages, aliases, helpers outside the level folders and the own folder, even through a detour', () => {
    const targetDir = tempLibrary({
      'src/atoms/Button/Button.tsx': [
        'import { useState } from \'react\';',
        'import { cn } from \'@/lib/cn\';',
        'import { cx } from \'../../lib/cn\';',
        'import { parts } from \'./parts/Parts\';',
        'import { self } from \'../Button/Button.variants\';',
        'import { other } from \'../../../outside\';',
      ].join('\n'),
      'src/atoms/Button/parts/Parts.tsx': 'import { Button } from \'../Button\';\n',
    });

    expect(run(targetDir)).toEqual([]);
  });

  test('scans stories, variants and nested files of a component, and skips non-script files', () => {
    const targetDir = tempLibrary({
      'src/atoms/Button/Button.stories.tsx': 'import { Card } from \'../../molecules/Card/Card\';\n',
      'src/atoms/Button/Button.variants.ts': '\nimport { x } from \'../Other/Other\';\n',
      'src/atoms/Button/parts/Inner.jsx': 'import { y } from \'../../../organisms/Header/Header\';\n',
      'src/atoms/Button/notes.md': 'import { z } from \'../../layouts/Page/Page\';\n',
      'src/atoms/Button/Button.css': '@import \'../../layouts/Page/Page.css\';\n',
    });

    expect(places(targetDir)).toEqual([
      'src/atoms/Button/Button.stories.tsx:1',
      'src/atoms/Button/Button.variants.ts:2',
      'src/atoms/Button/parts/Inner.jsx:1',
    ]);
  });

  test('ranks levels by the config\'s order, not by their names', () => {
    const files = {
      'src/base/Low/Low.tsx': 'import { Top } from \'../../top/Top/Top\';\n',
      'src/top/Top/Top.tsx': 'import { Low } from \'../../base/Low/Low\';\n',
    };
    const targetDir = tempLibrary(files);

    expect(places(targetDir, ['base', 'top'])).toEqual(['src/base/Low/Low.tsx:1']);
    expect(places(targetDir, ['top', 'base'])).toEqual(['src/top/Top/Top.tsx:1']);
  });

  test('names the importing component in each finding, in component then file order', () => {
    const targetDir = tempLibrary({
      'src/molecules/Card/Card.tsx': 'import { Box } from \'../Box/Box\';\n',
      'src/molecules/Box/Box.tsx': 'import { Card } from \'../Card/Card\';\n',
    });

    expect(run(targetDir).map(({ component, finding }) => `${component} ${finding.file}`)).toEqual([
      'Box src/molecules/Box/Box.tsx',
      'Card src/molecules/Card/Card.tsx',
    ]);
  });

  test('yields nothing for a library without components', () => {
    expect(run(tempLibrary({}))).toEqual([]);
  });
});
