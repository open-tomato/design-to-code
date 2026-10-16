/**
 * The relative imports of a library file, read with the TypeScript compiler
 * API, which the structure rules walk the import graph with.
 *
 * Every script file (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`,
 * `.cjs`) is parsed; any other file has no imports. Each import
 * declaration, `export … from` declaration and `import()` call with a
 * string literal is read, type-only ones included. A specifier that is not
 * relative (a package or an alias) is skipped; a relative one is resolved
 * against the importing file into a POSIX path relative to `target.dir`,
 * without guessing an extension. {@link parseScript} and
 * {@link resolveRelative} are the two halves of that reading, for rules
 * that walk more of a file's AST than its imports.
 *
 * @packageDocumentation
 */

import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import ts from 'typescript';

/** One relative import of a file. */
export interface RelativeImport {
  /** The specifier as written, such as `'../Icon/Icon'`. */
  readonly specifier: string;
  /** The specifier resolved against the importing file, POSIX-relative to `target.dir`. */
  readonly target: string;
  /** The 1-based line the import statement or `import()` call starts on. */
  readonly line: number;
}

/** The script kind of each file extension that is parsed. */
const SCRIPT_KINDS: Readonly<Record<string, ts.ScriptKind>> = {
  '.ts': ts.ScriptKind.TS,
  '.mts': ts.ScriptKind.TS,
  '.cts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
};

/** One import read from a file: its specifier and the node to report it at. */
interface ImportSite {
  readonly specifier: string;
  readonly node: ts.Node;
}

/** Every import, re-export and literal `import()` in `node` and below. */
function collectImports(node: ts.Node): readonly ImportSite[] {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
    && node.moduleSpecifier !== undefined
    && ts.isStringLiteral(node.moduleSpecifier)) {
    return [{ specifier: node.moduleSpecifier.text, node }];
  }

  const own = ts.isCallExpression(node)
    && node.expression.kind === ts.SyntaxKind.ImportKeyword
    && node.arguments[0] !== undefined
    && ts.isStringLiteralLike(node.arguments[0])
    ? [{ specifier: node.arguments[0].text, node }]
    : [];

  return [...own, ...node.getChildren().flatMap(collectImports)];
}

/** Whether `specifier` is relative: `.`, `..`, or starting `./` or `../`. */
function isRelative(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}

/** Whether `path` is `dir` or lies under it. */
export function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/**
 * Resolves `specifier`, as written in `file` (POSIX-relative to
 * `targetDir`), into a POSIX path relative to `targetDir`, without guessing
 * an extension; a specifier that is not relative resolves to nothing.
 */
export function resolveRelative(file: string, specifier: string): string | undefined {
  return isRelative(specifier)
    ? posix.normalize(posix.join(posix.dirname(file), specifier))
    : undefined;
}

/**
 * Parses `file` (POSIX-relative to `targetDir`) with the TypeScript
 * compiler API, parent links set; a file that is not a script parses to
 * nothing.
 *
 * @throws when the file cannot be read.
 */
export function parseScript(targetDir: string, file: string): ts.SourceFile | undefined {
  const scriptKind = SCRIPT_KINDS[posix.extname(file)];

  if (scriptKind === undefined) {
    return undefined;
  }

  const text = readFileSync(join(targetDir, file), 'utf8');

  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind);
}

/**
 * Reads the relative imports of `file` (POSIX-relative to `targetDir`), in
 * source order. A file that is not a script has none.
 *
 * @throws when the file cannot be read.
 */
export function readRelativeImports(targetDir: string, file: string): readonly RelativeImport[] {
  const source = parseScript(targetDir, file);

  if (source === undefined) {
    return [];
  }

  return collectImports(source).flatMap(({ specifier, node }) => {
    const target = resolveRelative(file, specifier);

    return target === undefined
      ? []
      : [{ specifier, target, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 }];
  });
}
