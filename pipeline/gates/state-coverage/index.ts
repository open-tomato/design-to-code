/**
 * The state coverage gate: checks that every state the seed manifest names
 * for a component has a story, and writes what it found as
 * `state-coverage` gate results.
 *
 * The manifest is read from `<source.dir>/seed-manifest.json` through
 * `readSeedManifest`. Each entry is looked up by name among the components
 * `listLibrary` lists under `<target.dir>/src/<level>/`; when two levels
 * hold a folder of that name, the lowest level's is used. An entry with no
 * folder is one `missing-component` finding.
 *
 * A state is covered when the component's `<Name>.stories.tsx` has a named
 * story export whose identifier is the state name in PascalCase (see
 * {@link toPascalCase}), or whose story object's `name` property is the
 * state name. Story exports are read from the file's AST with the
 * TypeScript compiler API, never by importing the file (see
 * {@link readStoryExports}). Each uncovered state is one
 * `missing-state-story` finding pointing at the stories file, which a
 * component with no stories file fails for every state.
 *
 * Every manifest entry gets one `state-coverage.json` under
 * `<target.dir>/gate-results/<component>/`: a `fail` carrying its findings
 * when it has any, a `pass` otherwise. A listed component the manifest does
 * not name has no states to cover and gets no result. When the library
 * holds zero files, the gate fails with a `scanned-zero-files` finding
 * under `_library`, so an empty or misplaced library never reads as a pass;
 * a `_library` result left by an earlier run is removed when this run
 * scans files. Every result carries the whole run's duration as its
 * `durationMs`.
 *
 * @packageDocumentation
 */

import type { ComponentEntry } from '../../seed/schema.ts';
import type { LibraryComponent } from '../library.ts';
import type { GateFinding, GateResult } from '../result.ts';

import { existsSync, rmSync } from 'node:fs';
import { join, posix } from 'node:path';

import ts from 'typescript';

import { readSeedManifest } from '../../seed/files.ts';
import { toResult } from '../findings.ts';
import { listLibrary, LIBRARY_SOURCE_DIR } from '../library.ts';
import { gateResultPath, LIBRARY_COMPONENT, scannedZeroFilesFinding, writeGateResult } from '../result.ts';
import { parseScript } from '../structure/rules/imports.ts';

/** The gate name, as written in results and result file names. */
export const STATE_COVERAGE_GATE = 'state-coverage';

/** The rule of the finding for a manifest state no story covers. */
export const MISSING_STATE_STORY_RULE = 'missing-state-story';

/** The rule of the finding for a manifest entry with no component folder. */
export const MISSING_COMPONENT_RULE = 'missing-component';

/** The suffix after `<Name>` of a component's stories file. */
const STORIES_SUFFIX = '.stories.tsx';

/** One named story export of a stories file. */
export interface StoryExport {
  /** The exported identifier, such as `WithActions`. */
  readonly identifier: string;
  /** The story object's `name` property, when it is a string literal; `null` otherwise. */
  readonly name: string | null;
}

/** What the state coverage gate reads. */
export interface StateCoverageGateOptions {
  /** The design export's root, the config's `source.dir`, holding `seed-manifest.json`. */
  readonly sourceDir: string;
  /** The library's root, the config's `target.dir`; results are written under it. */
  readonly targetDir: string;
  /** The level folder names, lowest first: the config's `levels`. */
  readonly levels: readonly string[];
  /** The clock, in milliseconds, used for `durationMs`; `performance.now` when left out. */
  readonly now?: () => number;
}

/** What one run of the state coverage gate wrote. */
export interface StateCoverageGateRun {
  /** `fail` when any result failed, `pass` otherwise. */
  readonly status: 'pass' | 'fail';
  /** Every result written, manifest entries first in manifest order, then `_library`. */
  readonly results: readonly GateResult[];
  /** The absolute path of each result, in the order of `results`. */
  readonly paths: readonly string[];
  /** The number of files in the library's component folders. */
  readonly scannedFiles: number;
}

/**
 * The state name `name` in PascalCase, as a story export would spell it:
 * split on every run of characters that are not ASCII letters or digits,
 * each piece's first character upper-cased and the rest kept, then joined.
 * `with-actions` reads `WithActions`, `default` reads `Default`.
 */
export function toPascalCase(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter((piece) => piece !== '')
    .map((piece) => `${piece.charAt(0).toUpperCase()}${piece.slice(1)}`)
    .join('');
}

/** `expression` with any parentheses, `as`, `satisfies` and `!` wrappers taken off. */
function unwrap(expression: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)) {
    return unwrap(expression.expression);
  }

  return expression;
}

/** The string-literal `name` property of `initializer` when it is an object literal, `null` otherwise. */
function storyName(initializer: ts.Expression | undefined): string | null {
  if (initializer === undefined) {
    return null;
  }

  const story = unwrap(initializer);

  if (!ts.isObjectLiteralExpression(story)) {
    return null;
  }

  const property = story.properties.find(
    (candidate): candidate is ts.PropertyAssignment => ts.isPropertyAssignment(candidate)
      && (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name))
      && candidate.name.text === 'name',
  );

  return property !== undefined && ts.isStringLiteralLike(property.initializer)
    ? property.initializer.text
    : null;
}

/** Whether `statement` carries the `export` modifier and not `default` or `declare`. */
function isNamedExport(statement: ts.Statement): boolean {
  const kinds = (ts.canHaveModifiers(statement)
    ? ts.getModifiers(statement) ?? []
    : []).map((modifier) => modifier.kind);

  return kinds.includes(ts.SyntaxKind.ExportKeyword)
    && !kinds.includes(ts.SyntaxKind.DefaultKeyword)
    && !kinds.includes(ts.SyntaxKind.DeclareKeyword);
}

/** The initializer of each top-level `const`, `let` or `var` declared with a plain identifier, by name. */
function localInitializers(source: ts.SourceFile): ReadonlyMap<string, ts.Expression | undefined> {
  return new Map(source.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .flatMap((declaration) => ts.isIdentifier(declaration.name)
      ? [[declaration.name.text, declaration.initializer] as const]
      : []));
}

/** The story exports of one top-level statement; `locals` resolves `export { local as Name }`. */
function statementExports(statement: ts.Statement, locals: ReadonlyMap<string, ts.Expression | undefined>): readonly StoryExport[] {
  if (ts.isVariableStatement(statement) && isNamedExport(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) => ts.isIdentifier(declaration.name)
      ? [{ identifier: declaration.name.text, name: storyName(declaration.initializer) }]
      : []);
  }

  if (ts.isFunctionDeclaration(statement) && isNamedExport(statement) && statement.name !== undefined) {
    return [{ identifier: statement.name.text, name: null }];
  }

  if (ts.isExportDeclaration(statement) && !statement.isTypeOnly
    && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
    const fromElsewhere = statement.moduleSpecifier !== undefined;

    return statement.exportClause.elements
      .filter((element) => !element.isTypeOnly && element.name.text !== 'default')
      .map((element) => {
        const local = (element.propertyName ?? element.name).text;

        return {
          identifier: element.name.text,
          name: fromElsewhere
            ? null
            : storyName(locals.get(local)),
        };
      });
  }

  return [];
}

/**
 * The named story exports of `file` (POSIX-relative to `targetDir`), read
 * from its AST in source order, without importing it. An exported `const`,
 * `let` or `var`, an exported function and each name of an
 * `export { … }` list count, re-exports from another module included; a
 * default export, a type-only export and a `declare` never do. A story's
 * `name` is read from an object literal initializer, through any `as`,
 * `satisfies` or parentheses, and for `export { local as Name }` from
 * `local`'s top-level declaration; a re-export from another module has no
 * `name` read.
 *
 * @throws when the file cannot be read.
 */
export function readStoryExports(targetDir: string, file: string): readonly StoryExport[] {
  const source = parseScript(targetDir, file);

  if (source === undefined) {
    return [];
  }

  const locals = localInitializers(source);

  return source.statements.flatMap((statement) => statementExports(statement, locals));
}

/** The `missing-state-story` findings of `entry`, whose folder is `component`. */
function stateFindings(targetDir: string, entry: ComponentEntry, component: LibraryComponent): readonly GateFinding[] {
  const storiesFile = posix.join(component.dir, `${component.name}${STORIES_SUFFIX}`);
  const hasStories = existsSync(join(targetDir, storiesFile));
  const stories = hasStories
    ? readStoryExports(targetDir, storiesFile)
    : [];
  const identifiers = new Set(stories.map((story) => story.identifier));
  const names = new Set(stories.flatMap((story) => story.name === null
    ? []
    : [story.name]));
  const stateNames = [...new Set(entry.states.map((state) => state.name))];

  return stateNames
    .filter((state) => !identifiers.has(toPascalCase(state)) && !names.has(state))
    .map((state) => ({
      rule: MISSING_STATE_STORY_RULE,
      file: storiesFile,
      line: null,
      message: hasStories
        ? `state "${state}" has no story: export one named ${toPascalCase(state)}, or give a story the name "${state}"`
        : `state "${state}" has no story: ${storiesFile} does not exist`,
    }));
}

/** The findings of one manifest entry: `missing-component`, or one per uncovered state. */
function entryFindings(
  targetDir: string,
  entry: ComponentEntry,
  components: readonly LibraryComponent[],
): readonly GateFinding[] {
  const component = components.find((candidate) => candidate.name === entry.name);

  if (component === undefined) {
    return [{
      rule: MISSING_COMPONENT_RULE,
      file: null,
      line: null,
      message: `the seed manifest names ${entry.name}, but no level folder under ${LIBRARY_SOURCE_DIR} holds a ${entry.name} folder`,
    }];
  }

  return stateFindings(targetDir, entry, component);
}

/**
 * Reads the seed manifest under `sourceDir`, checks each entry's states
 * against the stories of the library at `targetDir`, read through
 * `levels`, and writes one `state-coverage.json` per manifest entry, plus
 * one for `_library` when the library holds zero files.
 *
 * @throws SeedFileError when the manifest is missing (naming
 *   `bun run d2c seed`), is not JSON or fails its schema; any other error
 *   reading the manifest throws the file system's error.
 * @throws when a level is not a single folder name, when a stories file
 *   cannot be read, or when a result cannot be written, such as for an
 *   entry name that is not a single path segment.
 */
export function runStateCoverageGate(options: StateCoverageGateOptions): StateCoverageGateRun {
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const manifest = readSeedManifest(options.sourceDir);
  const library = listLibrary(options.targetDir, options.levels);
  const found = manifest.components.map((entry) => [entry.name, entryFindings(options.targetDir, entry, library.components)] as const);
  const zeroFiles = library.scannedFiles === 0
    ? [[LIBRARY_COMPONENT, [scannedZeroFilesFinding(LIBRARY_SOURCE_DIR)]] as const]
    : [];
  const durationMs = Math.max(0, now() - startedAt);
  const results = [...found, ...zeroFiles].map(([component, findings]) => toResult(STATE_COVERAGE_GATE, component, findings, durationMs));

  if (zeroFiles.length === 0) {
    rmSync(gateResultPath(options.targetDir, LIBRARY_COMPONENT, STATE_COVERAGE_GATE), { force: true });
  }

  const paths = results.map((result) => writeGateResult(options.targetDir, result));
  const status = results.some((result) => result.status === 'fail')
    ? 'fail'
    : 'pass';

  return { status, results, paths, scannedFiles: library.scannedFiles };
}
