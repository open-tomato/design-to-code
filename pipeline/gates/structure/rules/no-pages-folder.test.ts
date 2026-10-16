import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { DEFAULT_LEVELS } from '../../../../config/schema.ts';
import { listLibrary } from '../../library.ts';
import { gateFindingSchema, LIBRARY_COMPONENT } from '../../result.ts';

import { layerImports } from './layer-imports.ts';
import { layoutChildrenOnly } from './layout-children-only.ts';
import { NO_PAGES_FOLDER_RULE, noPagesFolder } from './no-pages-folder.ts';
import { sharedVariants } from './shared-variants.ts';

const FIXTURE_DIR = resolve(import.meta.dirname, '../../fixtures/structure/no-pages-folder');
const dirs: string[] = [];

/** The rule's input for the library at `targetDir`. */
function input(targetDir: string) {
  return { targetDir, levels: DEFAULT_LEVELS, components: listLibrary(targetDir, DEFAULT_LEVELS).components };
}

/** A temp library holding each directory of `paths` (POSIX, relative to it), each with one file. */
function tempLibrary(paths: readonly string[]): string {
  const targetDir = mkdtempSync(join(tmpdir(), 'd2c-no-pages-folder-'));

  dirs.push(targetDir);

  for (const path of paths) {
    mkdirSync(join(targetDir, path), { recursive: true });
    writeFileSync(join(targetDir, path, 'index.ts'), 'export {};\n');
  }

  return targetDir;
}

/** The `file` of each finding over a temp library holding `paths`. */
function files(paths: readonly string[]): readonly (string | null)[] {
  return noPagesFolder(input(tempLibrary(paths))).map(({ finding }) => finding.file);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('noPagesFolder over the fixtures', () => {
  test('the failing fixture yields one _library finding per pages folder', () => {
    const findings = noPagesFolder(input(join(FIXTURE_DIR, 'failing')));
    const advice = 'the library holds components only, so pages live in the app that uses it';

    expect(findings).toEqual([
      {
        component: LIBRARY_COMPONENT,
        finding: {
          rule: NO_PAGES_FOLDER_RULE,
          file: 'src/organisms/Header/pages',
          line: null,
          message: `src/organisms/Header/pages is a pages folder; ${advice}`,
        },
      },
      {
        component: LIBRARY_COMPONENT,
        finding: {
          rule: NO_PAGES_FOLDER_RULE,
          file: 'src/pages',
          line: null,
          message: `src/pages is a pages folder; ${advice}`,
        },
      },
    ]);
    for (const { finding } of findings) {
      expect(gateFindingSchema.parse(finding)).toEqual(finding);
    }
  });

  test('the passing fixture yields no finding', () => {
    expect(noPagesFolder(input(join(FIXTURE_DIR, 'passing')))).toEqual([]);
  });

  test('the failing fixture breaks no other structure rule', () => {
    const library = input(join(FIXTURE_DIR, 'failing'));

    expect([...layerImports(library), ...sharedVariants(library), ...layoutChildrenOnly(library)]).toEqual([]);
  });
});

describe('noPagesFolder over temp libraries', () => {
  test('finds a pages folder at any depth, nested ones each on their own', () => {
    expect(files(['src/atoms/Button', 'src/a/b/c/pages', 'src/pages/pages'])).toEqual([
      'src/a/b/c/pages',
      'src/pages',
      'src/pages/pages',
    ]);
  });

  test('matches the name exactly, not by prefix, suffix or case', () => {
    expect(files(['src/Pages', 'src/pages-old', 'src/mypages', 'src/organisms/Pager'])).toEqual([]);
  });

  test('ignores a pages folder outside src', () => {
    expect(files(['pages', 'other/pages', 'src/atoms/Button'])).toEqual([]);
  });

  test('ignores a file named pages', () => {
    const targetDir = tempLibrary(['src/atoms']);

    writeFileSync(join(targetDir, 'src/pages'), 'not a folder\n');

    expect(noPagesFolder(input(targetDir))).toEqual([]);
  });

  test('does not follow a symbolic link named pages', () => {
    const targetDir = tempLibrary(['src/atoms', 'elsewhere']);

    symlinkSync(join(targetDir, 'elsewhere'), join(targetDir, 'src/pages'));

    expect(noPagesFolder(input(targetDir))).toEqual([]);
  });

  test('a library with no src yields no finding', () => {
    expect(files(['lib'])).toEqual([]);
  });
});
