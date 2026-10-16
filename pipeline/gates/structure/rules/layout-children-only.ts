/**
 * The `layout-children-only` structure rule: a layout passes a library
 * component nothing but `children` and `key`; other data reaches it through
 * context.
 *
 * Only components of the highest level (the last of `levels`) are read.
 * Every script file in such a component's folder is parsed, except its
 * stories and tests (`*.stories.*`, `*.test.*`, `*.spec.*`), which render
 * the layout itself rather than being it.
 *
 * A JSX element renders a library component when the leftmost name of its
 * tag (`Card` in `<Card>`, `Atoms` in `<Atoms.Button>`) is bound by a value
 * import (default, named or namespace) whose relative specifier resolves
 * inside a level folder (`<target.dir>/src/<level>/…`, a component or a
 * barrel sitting directly in the level folder) and outside the layout's own
 * folder. Type-only imports cannot render, and package or alias specifiers
 * are never resolved, so neither binds a library component.
 *
 * Such an element's attributes may only be `children` and `key`. Any other
 * attribute, and every spread attribute (`{...props}`, which may carry
 * anything), makes the element one finding naming the file, the 1-based
 * line its tag opens on, and each refused attribute in source order.
 *
 * @packageDocumentation
 */

import type { StructureFinding, StructureRuleInput } from './rule.ts';
import type { LibraryComponent } from '../../library.ts';

import { posix } from 'node:path';

import ts from 'typescript';

import { LIBRARY_SOURCE_DIR } from '../../library.ts';

import { isInside, parseScript, resolveRelative } from './imports.ts';

/** The rule name written in each finding. */
export const LAYOUT_CHILDREN_ONLY_RULE = 'layout-children-only';

/** The attributes a layout may pass to a library component. */
const ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set(['children', 'key']);

/** The files of a component that render it rather than being it. */
const NOT_THE_COMPONENT = /\.(?:stories|test|spec)\.[cm]?[jt]sx?$/u;

/** One JSX element, opening or self-closing. */
type JsxTag = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

/** Whether `target` lies in a level folder and outside `component`'s own folder. */
function isLibraryComponent(target: string, levels: readonly string[], component: LibraryComponent): boolean {
  return levels.some((level) => isInside(target, posix.join(LIBRARY_SOURCE_DIR, level)))
    && !isInside(target, component.dir);
}

/** The local names an import clause binds as values. */
function valueBindings(clause: ts.ImportClause): readonly string[] {
  if (clause.isTypeOnly) {
    return [];
  }

  const own = clause.name === undefined
    ? []
    : [clause.name.text];
  const named = clause.namedBindings;

  if (named === undefined) {
    return own;
  }

  if (ts.isNamespaceImport(named)) {
    return [...own, named.name.text];
  }

  return [...own, ...named.elements.filter((element) => !element.isTypeOnly).map((element) => element.name.text)];
}

/** The local names `source` binds to library components outside `component`'s folder. */
function libraryBindings(
  source: ts.SourceFile,
  file: string,
  levels: readonly string[],
  component: LibraryComponent,
): ReadonlySet<string> {
  return new Set(source.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement)
      || statement.importClause === undefined
      || !ts.isStringLiteral(statement.moduleSpecifier)) {
      return [];
    }

    const target = resolveRelative(file, statement.moduleSpecifier.text);

    return target !== undefined && isLibraryComponent(target, levels, component)
      ? valueBindings(statement.importClause)
      : [];
  }));
}

/** Every JSX opening and self-closing element in `node` and below, in source order. */
function collectTags(node: ts.Node): readonly JsxTag[] {
  const own = ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)
    ? [node]
    : [];

  return [...own, ...node.getChildren().flatMap(collectTags)];
}

/** The leftmost name of a tag, such as `Atoms` in `Atoms.Button`, if it has one. */
function rootName(tagName: ts.JsxTagNameExpression): string | undefined {
  if (ts.isIdentifier(tagName)) {
    return tagName.text;
  }

  return ts.isPropertyAccessExpression(tagName)
    ? rootName(tagName.expression as ts.JsxTagNameExpression)
    : undefined;
}

/** The attributes of `tag` a layout may not pass, as written, in source order. */
function refusedAttributes(tag: JsxTag, source: ts.SourceFile): readonly string[] {
  return tag.attributes.properties.flatMap((attribute) => {
    if (ts.isJsxSpreadAttribute(attribute)) {
      return [attribute.getText(source)];
    }

    const name = attribute.name.getText(source);

    return ALLOWED_ATTRIBUTES.has(name)
      ? []
      : [name];
  });
}

/** The findings of one file of the layout `component`. */
function checkFile(input: StructureRuleInput, component: LibraryComponent, file: string): readonly StructureFinding[] {
  const source = parseScript(input.targetDir, file);

  if (source === undefined) {
    return [];
  }

  const bindings = libraryBindings(source, file, input.levels, component);

  return collectTags(source).flatMap((tag): readonly StructureFinding[] => {
    const root = rootName(tag.tagName);
    const refused = refusedAttributes(tag, source);

    if (root === undefined || !bindings.has(root) || refused.length === 0) {
      return [];
    }

    const rendered = tag.tagName.getText(source);

    return [{
      component: component.name,
      finding: {
        rule: LAYOUT_CHILDREN_ONLY_RULE,
        file,
        line: source.getLineAndCharacterOfPosition(tag.getStart(source)).line + 1,
        message: `${component.name} (${component.level}) passes ${refused.join(', ')} to ${rendered}; `
          + 'a layout passes a library component nothing but children and key, other data reaches it through context',
      },
    }];
  });
}

/**
 * Finds every JSX element, in every component of the highest level, that
 * renders a library component with an attribute other than `children` and
 * `key`. Findings come in component order, then file order, then source
 * order.
 *
 * @throws when a component file cannot be read.
 */
export function layoutChildrenOnly(input: StructureRuleInput): readonly StructureFinding[] {
  const highest = input.levels.at(-1);

  return input.components
    .filter((component) => component.level === highest)
    .flatMap((component) => component.files
      .filter((file) => !NOT_THE_COMPONENT.test(file))
      .flatMap((file) => checkFile(input, component, file)));
}
