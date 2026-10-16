/**
 * The test-isolation import check. A test that starts an HTTP server or
 * launches Chromium belongs in the serial `integration` vitest project, so it
 * must be named `*.integration.test.ts` under one of the tracked test folders.
 * This check fails when any other `*.test.ts` file in the repo has a value
 * import of a module that starts a server or a browser: `pipeline/serve/server.ts`,
 * `pipeline/seed/run.ts`, `bin/verbs/serve.ts` or the `playwright` package.
 *
 * An `import type` declaration (or `export type … from`) passes, since it is
 * erased before the file runs. Any other import declaration, `export … from`
 * declaration or literal `import()` call counts as a value import, including
 * `import { type A } from …`: under `verbatimModuleSyntax` that form still
 * loads the module.
 *
 * @packageDocumentation
 */

import { globSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import ts from 'typescript';
import { describe, expect, test } from 'vitest';

/** The repo root, which every path in this check is POSIX-relative to. */
const REPO_ROOT = join(import.meta.dirname, '..');

/**
 * The folders the `integration` project's include reaches, as the
 * `TEST_DIRS` constant of `vitest.config.ts` names them. A test below pins
 * the two in step.
 */
const INTEGRATION_DIRS: ReadonlySet<string> = new Set(['bin', 'config', 'harness', 'pipeline', 'scripts', 'templates']);

/** The file name suffix the `integration` project's include matches. */
const INTEGRATION_SUFFIX = '.integration.test.ts';

/** The repo modules that start a server, without their extension. */
const FORBIDDEN_MODULE_STEMS: readonly string[] = [
  'pipeline/serve/server',
  'pipeline/seed/run',
  'bin/verbs/serve',
];

/** The package that launches Chromium. */
const FORBIDDEN_PACKAGE = 'playwright';

/** The extensions a relative specifier may carry and still name a `.ts` module. */
const SCRIPT_EXTENSION = /\.(?:ts|js|mts|mjs)$/;

/** A test file's path, POSIX-relative to the repo root, and its text. */
interface TestSource {
  readonly path: string;
  readonly text: string;
}

/** One forbidden value import: the file, the line it starts on and the specifier as written. */
interface ForbiddenImport {
  readonly path: string;
  readonly line: number;
  readonly specifier: string;
}

/** One value import read from a file: its specifier and the node it is written at. */
interface ValueImport {
  readonly specifier: string;
  readonly node: ts.Node;
}

/** Whether `path` falls inside the `integration` project's include. */
function isIntegrationTest(path: string): boolean {
  const [topDir] = path.split('/');

  return topDir !== undefined && INTEGRATION_DIRS.has(topDir) && path.endsWith(INTEGRATION_SUFFIX);
}

/** Every value import, value re-export and literal `import()` in `node` and below. */
function collectValueImports(node: ts.Node): readonly ValueImport[] {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
    return node.importClause?.isTypeOnly === true
      ? []
      : [{ specifier: node.moduleSpecifier.text, node }];
  }

  if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
    return node.isTypeOnly
      ? []
      : [{ specifier: node.moduleSpecifier.text, node }];
  }

  const own = ts.isCallExpression(node)
    && node.expression.kind === ts.SyntaxKind.ImportKeyword
    && node.arguments[0] !== undefined
    && ts.isStringLiteralLike(node.arguments[0])
    ? [{ specifier: node.arguments[0].text, node }]
    : [];

  return [...own, ...node.getChildren().flatMap(collectValueImports)];
}

/** Whether `specifier`, written in the file at `path`, names a module that starts a server or a browser. */
function isForbidden(path: string, specifier: string): boolean {
  if (specifier === FORBIDDEN_PACKAGE || specifier.startsWith(`${FORBIDDEN_PACKAGE}/`)) {
    return true;
  }

  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    return false;
  }

  const target = posix.normalize(posix.join(posix.dirname(path), specifier));

  return FORBIDDEN_MODULE_STEMS.includes(target.replace(SCRIPT_EXTENSION, ''));
}

/** The forbidden value imports of every source outside the `integration` project's include. */
function findForbiddenImports(sources: readonly TestSource[]): readonly ForbiddenImport[] {
  return sources
    .filter((source) => !isIntegrationTest(source.path))
    .flatMap((source) => {
      const file = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

      return collectValueImports(file)
        .filter(({ specifier }) => isForbidden(source.path, specifier))
        .map(({ specifier, node }) => ({
          path: source.path,
          line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
          specifier,
        }));
    });
}

/** One line per forbidden import, naming the file, line and import. */
function describeForbidden(found: readonly ForbiddenImport[]): readonly string[] {
  return found.map(({ path, line, specifier }) => `${path}:${line} has a value import of '${specifier}'`);
}

/** Every `*.test.ts` file in the repo outside `node_modules`, read from disk. */
function readRepoTestSources(): readonly TestSource[] {
  const paths = globSync('**/*.test.ts', {
    cwd: REPO_ROOT,
    exclude: (name: string) => posix.basename(name) === 'node_modules',
  });

  return paths.map((path) => ({
    path: path.split('\\').join('/'),
    text: readFileSync(join(REPO_ROOT, path), 'utf8'),
  }));
}

describe('findForbiddenImports', () => {
  test('names the file, line and import of a value import of the server in a unit test', () => {
    const sources = [{
      path: 'pipeline/serve/pages.test.ts',
      text: [
        'import { describe } from \'vitest\';',
        '',
        'import { startServer } from \'./server.ts\';',
      ].join('\n'),
    }];

    expect(describeForbidden(findForbiddenImports(sources))).toEqual([
      'pipeline/serve/pages.test.ts:3 has a value import of \'./server.ts\'',
    ]);
  });

  test('fails every forbidden module and the playwright package, however each is imported', () => {
    const sources = [{
      path: 'bin/d2c.example.test.ts',
      text: [
        'import { chromium } from \'playwright\';',
        'import \'../pipeline/seed/run.ts\';',
        'export { runServe } from \'./verbs/serve.ts\';',
        'import { type ServerHandle } from \'../pipeline/serve/server\';',
        'const devices = await import(\'playwright/devices\');',
      ].join('\n'),
    }];

    expect(findForbiddenImports(sources).map(({ specifier }) => specifier)).toEqual([
      'playwright',
      '../pipeline/seed/run.ts',
      './verbs/serve.ts',
      '../pipeline/serve/server',
      'playwright/devices',
    ]);
  });

  test('passes an import type of the server and the playwright package', () => {
    const sources = [{
      path: 'pipeline/serve/pages.test.ts',
      text: [
        'import type { ServerHandle } from \'./server.ts\';',
        'import type { Page } from \'playwright\';',
        'export type { SeedResult } from \'../seed/run.ts\';',
      ].join('\n'),
    }];

    expect(findForbiddenImports(sources)).toEqual([]);
  });

  test('passes a value import of the server in a *.integration.test.ts file', () => {
    const sources = [{
      path: 'pipeline/serve/server-port.integration.test.ts',
      text: 'import { startServer } from \'./server.ts\';\nimport { chromium } from \'playwright\';',
    }];

    expect(findForbiddenImports(sources)).toEqual([]);
  });

  test('fails a *.integration.test.ts file outside the integration project\'s folders', () => {
    const sources = [{
      path: 'docs/server.integration.test.ts',
      text: 'import { chromium } from \'playwright\';',
    }];

    expect(describeForbidden(findForbiddenImports(sources))).toEqual([
      'docs/server.integration.test.ts:1 has a value import of \'playwright\'',
    ]);
  });

  test('passes modules that only share a prefix with a forbidden one', () => {
    const sources = [{
      path: 'pipeline/serve/pages.test.ts',
      text: [
        'import { readServeRecord } from \'./serve-record.ts\';',
        'import { portCandidates } from \'./port.ts\';',
        'import { chromium } from \'playwright-core\';',
        'import { runSeed } from \'../seed/run-options.ts\';',
      ].join('\n'),
    }];

    expect(findForbiddenImports(sources)).toEqual([]);
  });
});

describe('the repo\'s test files', () => {
  test('keep their include folders in step with vitest.config.ts', () => {
    const config = readFileSync(join(REPO_ROOT, 'vitest.config.ts'), 'utf8');

    expect(config).toContain(`const TEST_DIRS = '{${[...INTEGRATION_DIRS].join(',')}}';`);
    expect(config).toContain(`const INTEGRATION_TEST_GLOB = '**/*${INTEGRATION_SUFFIX}';`);
  });

  test('include this file and a *.integration.test.ts file, so the glob reaches the tree', () => {
    const paths = readRepoTestSources().map(({ path }) => path);

    expect(paths).toContain('scripts/test-isolation.test.ts');
    expect(paths).toContain('pipeline/serve/server.integration.test.ts');
    expect(paths.some((path) => path.includes('node_modules'))).toBe(false);
  });

  test('have no value import of a server or browser module outside the integration project', () => {
    expect(describeForbidden(findForbiddenImports(readRepoTestSources()))).toEqual([]);
  });
});
