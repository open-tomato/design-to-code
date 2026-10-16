/**
 * The story health gate's browser-free checks: the rules a story file or
 * the harness preview breaks without a browser ever rendering it.
 *
 * - `no-vitest-in-stories`: a story file (a file named `*.stories.<ext>`,
 *   for a script extension `parseScript` reads) never imports `vitest`,
 *   `vitest/…` or `@vitest/…`. An import or re-export declaration, an
 *   `import()` call and a `require()` call with a string literal each
 *   count, type-only ones included, since the Storybook preview crashes on
 *   `vitest` whatever the import's form.
 * - `no-cross-folder-barrel`: a story file never imports, through a
 *   relative specifier, another component folder's `index` file or the
 *   library's `src/index` file, both barrels whose re-exports render
 *   `undefined` in the production Storybook build. A specifier naming the
 *   folder, its `index`, or its `index` with an extension resolves to the
 *   barrel when such an `index` file exists (see {@link BARREL_EXTENSIONS}).
 *   Type-only imports and re-exports are erased before the build and never
 *   count; an import of the story's own folder's barrel is not
 *   cross-folder; an aliased or package specifier is not read.
 * - `preview-deterministic`: the harness preview (by default
 *   {@link HARNESS_PREVIEW_PATH}) exports each of
 *   {@link DETERMINISM_EXPORTS}, the fixed clock and the random seed every
 *   story runs under. The preview is read from its AST, never imported, so
 *   its Vite virtual module never needs resolving.
 *
 * Story-file findings belong to the component whose folder holds the file
 * and name its path (POSIX-relative to `target.dir`) and the 1-based line
 * of the import. The preview lies outside `target.dir`, so its findings
 * have no `file` or `line`, name the preview's path in the message, and
 * belong to `_library`.
 *
 * @packageDocumentation
 */

import type { LibraryComponent } from '../library.ts';
import type { GateFinding } from '../result.ts';

import { existsSync, readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';

import ts from 'typescript';

import { LIBRARY_SOURCE_DIR } from '../library.ts';
import { LIBRARY_COMPONENT } from '../result.ts';
import { parseScript, resolveRelative } from '../structure/rules/imports.ts';

/** The rule of the finding for a story file importing `vitest`. */
export const NO_VITEST_IN_STORIES_RULE = 'no-vitest-in-stories';

/** The rule of the finding for a story file importing another folder's barrel. */
export const NO_CROSS_FOLDER_BARREL_RULE = 'no-cross-folder-barrel';

/** The rule of the finding for a preview without the fixed clock or seeded random. */
export const PREVIEW_DETERMINISTIC_RULE = 'preview-deterministic';

/** The managed Storybook's preview, which every story of every project renders under. */
export const HARNESS_PREVIEW_PATH = resolve(import.meta.dirname, '../../../harness/.storybook/preview.ts');

/** The named exports a deterministic preview carries: the fixed clock and the random seed. */
export const DETERMINISM_EXPORTS = ['FIXED_CLOCK', 'RANDOM_SEED'] as const;

/** The extensions an `index` file may carry and still be a barrel. */
export const BARREL_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;

/** A story file's name: `<anything>.stories.` and a script extension. */
const STORY_FILE = /\.stories\.(?:[cm]?[jt]s|[jt]sx)$/;

/** A specifier naming `vitest` or one of its packages. */
const VITEST_SPECIFIER = /^(?:vitest(?:\/.*)?|@vitest\/.+)$/;

/** The base name a barrel file carries, before its extension. */
const BARREL_NAME = 'index';

/** One finding of a static check, and the component whose result it goes in. */
export interface StoryHealthFinding {
  /** The component the finding belongs to, or `_library` when it belongs to none. */
  readonly component: string;
  /** The finding itself, as written in the gate result. */
  readonly finding: GateFinding;
}

/** What the static checks read. */
export interface StaticChecksInput {
  /** The library's root, the config's `target.dir`; component paths are relative to it. */
  readonly targetDir: string;
  /** The library's components, as `listLibrary` lists them. */
  readonly components: readonly LibraryComponent[];
  /** The preview `preview-deterministic` reads; {@link HARNESS_PREVIEW_PATH} when left out. */
  readonly previewPath?: string;
}

/** One module a file references: its specifier, whether it is type-only, and its line. */
interface ModuleReference {
  readonly specifier: string;
  readonly isTypeOnly: boolean;
  readonly line: number;
}

/** Whether an import declaration imports types only: `import type`, or every named binding marked `type`. */
function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;

  if (clause === undefined) {
    return false;
  }

  if (clause.isTypeOnly) {
    return true;
  }

  const bindings = clause.namedBindings;

  return clause.name === undefined
    && bindings !== undefined
    && ts.isNamedImports(bindings)
    && bindings.elements.length > 0
    && bindings.elements.every((element) => element.isTypeOnly);
}

/** Whether a re-export declaration re-exports types only. */
function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  const clause = node.exportClause;

  return node.isTypeOnly
    || (clause !== undefined
      && ts.isNamedExports(clause)
      && clause.elements.length > 0
      && clause.elements.every((element) => element.isTypeOnly));
}

/** The string-literal specifier of an `import()` or `require()` call, or nothing. */
function callSpecifier(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node)) {
    return undefined;
  }

  const isLoader = node.expression.kind === ts.SyntaxKind.ImportKeyword
    || (ts.isIdentifier(node.expression) && node.expression.text === 'require');
  const [argument] = node.arguments;

  return isLoader && argument !== undefined && ts.isStringLiteralLike(argument)
    ? argument.text
    : undefined;
}

/** Every module `node` and its descendants reference, in source order. */
function collectReferences(source: ts.SourceFile, node: ts.Node): readonly ModuleReference[] {
  const line = () => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
    && node.moduleSpecifier !== undefined
    && ts.isStringLiteral(node.moduleSpecifier)) {
    const isTypeOnly = ts.isImportDeclaration(node)
      ? isTypeOnlyImport(node)
      : isTypeOnlyExport(node);

    return [{ specifier: node.moduleSpecifier.text, isTypeOnly, line: line() }];
  }

  const specifier = callSpecifier(node);
  const own = specifier === undefined
    ? []
    : [{ specifier, isTypeOnly: false, line: line() }];

  return [...own, ...node.getChildren(source).flatMap((child) => collectReferences(source, child))];
}

/** Each story file of each component, with its component. */
function storyFiles(components: readonly LibraryComponent[]): readonly { component: LibraryComponent; file: string }[] {
  return components.flatMap((component) => component.files
    .filter((file) => STORY_FILE.test(posix.basename(file)))
    .map((file) => ({ component, file })));
}

/** The modules `file` (POSIX-relative to `targetDir`) references. */
function readReferences(targetDir: string, file: string): readonly ModuleReference[] {
  const source = parseScript(targetDir, file);

  return source === undefined
    ? []
    : collectReferences(source, source);
}

/**
 * Finds every `vitest` import in the components' story files, one finding
 * per import, in component order, then file order, then source order.
 *
 * @throws when a story file cannot be read.
 */
export function noVitestInStories(input: StaticChecksInput): readonly StoryHealthFinding[] {
  return storyFiles(input.components).flatMap(({ component, file }) => readReferences(input.targetDir, file)
    .filter((reference) => VITEST_SPECIFIER.test(reference.specifier))
    .map((reference) => ({
      component: component.name,
      finding: {
        rule: NO_VITEST_IN_STORIES_RULE,
        file,
        line: reference.line,
        message: `${file} imports '${reference.specifier}'; a story file never imports vitest, `
          + 'which crashes the Storybook preview: keep tests in a *.test.ts file',
      },
    })));
}

/** The folder `resolved` (POSIX-relative to `target.dir`) names as a barrel: itself less any trailing `/`, or less `/index` and any extension. */
function barrelFolder(resolved: string): string {
  const target = resolved.replace(/\/+$/, '');
  const extension = BARREL_EXTENSIONS.find((candidate) => target.endsWith(`/${BARREL_NAME}${candidate}`));
  const withoutExtension = extension === undefined
    ? target
    : target.slice(0, -extension.length);

  return withoutExtension.endsWith(`/${BARREL_NAME}`)
    ? withoutExtension.slice(0, -(BARREL_NAME.length + 1))
    : withoutExtension;
}

/** Whether `folder` (POSIX-relative to `targetDir`) holds an `index` file with a barrel extension. */
function holdsBarrel(targetDir: string, folder: string): boolean {
  return BARREL_EXTENSIONS.some((extension) => existsSync(resolve(targetDir, folder, `${BARREL_NAME}${extension}`)));
}

/** The barrel `folder` is, when it is the library's `src` or a component folder other than `own`'s. */
function crossedBarrel(folder: string, own: LibraryComponent, components: readonly LibraryComponent[]): string | undefined {
  if (folder === LIBRARY_SOURCE_DIR) {
    return 'the library\'s src';
  }

  const other = components.find((component) => component.dir === folder);

  return other === undefined || other.dir === own.dir
    ? undefined
    : `${other.name}'s folder`;
}

/**
 * Finds every value import in the components' story files that resolves to
 * another component folder's barrel or the library's `src` barrel, one
 * finding per import, in component order, then file order, then source
 * order.
 *
 * @throws when a story file cannot be read.
 */
export function noCrossFolderBarrel(input: StaticChecksInput): readonly StoryHealthFinding[] {
  return storyFiles(input.components).flatMap(({ component, file }) => readReferences(input.targetDir, file)
    .filter((reference) => !reference.isTypeOnly)
    .flatMap((reference) => {
      const target = resolveRelative(file, reference.specifier);
      const folder = target === undefined
        ? undefined
        : barrelFolder(target);
      const barrel = folder === undefined
        ? undefined
        : crossedBarrel(folder, component, input.components);

      if (folder === undefined || barrel === undefined || !holdsBarrel(input.targetDir, folder)) {
        return [];
      }

      return [{
        component: component.name,
        finding: {
          rule: NO_CROSS_FOLDER_BARREL_RULE,
          file,
          line: reference.line,
          message: `${file} imports '${reference.specifier}', the barrel of ${barrel}, whose re-exports `
            + 'render undefined in the production Storybook build: import the component\'s own file instead',
        },
      }];
    }));
}

/** Whether `statement` carries the `export` modifier and not `default`. */
function isNamedExport(statement: ts.Statement): boolean {
  const kinds = (ts.canHaveModifiers(statement)
    ? ts.getModifiers(statement) ?? []
    : []).map((modifier) => modifier.kind);

  return kinds.includes(ts.SyntaxKind.ExportKeyword) && !kinds.includes(ts.SyntaxKind.DefaultKeyword);
}

/** The value names `statement` exports. */
function exportedNames(statement: ts.Statement): readonly string[] {
  if (ts.isVariableStatement(statement) && isNamedExport(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) => ts.isIdentifier(declaration.name)
      ? [declaration.name.text]
      : []);
  }

  if (ts.isFunctionDeclaration(statement) && isNamedExport(statement) && statement.name !== undefined) {
    return [statement.name.text];
  }

  if (ts.isExportDeclaration(statement) && !statement.isTypeOnly
    && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
    return statement.exportClause.elements
      .filter((element) => !element.isTypeOnly)
      .map((element) => element.name.text);
  }

  return [];
}

/** A `_library` `preview-deterministic` finding with `message`. */
function previewFinding(message: string): StoryHealthFinding {
  return {
    component: LIBRARY_COMPONENT,
    finding: { rule: PREVIEW_DETERMINISTIC_RULE, file: null, line: null, message },
  };
}

/**
 * Checks that the preview at `previewPath` exports each of
 * {@link DETERMINISM_EXPORTS}: one `_library` finding per missing export,
 * or a single one when the preview does not exist.
 *
 * @throws when the preview exists but cannot be read.
 */
export function previewDeterministic(previewPath: string = HARNESS_PREVIEW_PATH): readonly StoryHealthFinding[] {
  if (!existsSync(previewPath)) {
    return [previewFinding(`the Storybook preview ${previewPath} does not exist, so no story runs under a fixed clock and seeded random`)];
  }

  const source = ts.createSourceFile(previewPath, readFileSync(previewPath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const exported = new Set(source.statements.flatMap(exportedNames));

  return DETERMINISM_EXPORTS
    .filter((name) => !exported.has(name))
    .map((name) => previewFinding(`the Storybook preview ${previewPath} does not export ${name}; `
      + 'every story must run under the fixed clock and seeded random it exports'));
}

/**
 * Runs every static check over the library: `no-vitest-in-stories`, then
 * `no-cross-folder-barrel`, then `preview-deterministic`.
 *
 * @throws when a story file or the preview exists but cannot be read.
 */
export function runStaticChecks(input: StaticChecksInput): readonly StoryHealthFinding[] {
  return [
    ...noVitestInStories(input),
    ...noCrossFolderBarrel(input),
    ...previewDeterministic(input.previewPath),
  ];
}
