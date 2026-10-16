import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import tsParser from '@typescript-eslint/parser';
import { ESLint, RuleTester } from 'eslint';
import { describe, expect, it, test } from 'vitest';

import { CVA_ONLY_CLASSNAME_RULE, cvaOnlyClassname } from './cva-only-classname.mjs';

// RuleTester reaches for global `describe` and `it`; vitest exports them
// instead, so hand them over before `run` builds its suites.
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 'latest',
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

/** The imports every case shares: the library's `cn`, `cva` and a colocated variants module. */
const IMPORTS = [
  'import { cn } from \'../../lib/cn\';',
  'import { cva } from \'../../lib/variants\';',
  'import { buttonVariants } from \'./Button.variants\';',
].join('\n');

/** A `Button` source returning `<button className={value} />`, after {@link IMPORTS} and `prelude`. */
function button(value: string, prelude = ''): string {
  return [
    IMPORTS,
    prelude,
    'export function Button({ intent, className }: { intent?: string; className?: string }) {',
    `  return <button className=${value} />;`,
    '}',
  ].join('\n');
}

/** The line of `<button className=… />` in a {@link button} source whose `prelude` holds no line break. */
const ATTRIBUTE_LINE = 6;

describe('the rule module', () => {
  test('is named cva-only-classname and refuses as a problem', () => {
    expect(CVA_ONLY_CLASSNAME_RULE).toBe('cva-only-classname');
    expect(cvaOnlyClassname.meta?.type).toBe('problem');
  });
});

ruleTester.run(CVA_ONLY_CLASSNAME_RULE, cvaOnlyClassname, {
  valid: [
    {
      name: 'a call of a variants function imported from a .variants module',
      code: button('{buttonVariants({ intent })}'),
    },
    {
      name: 'a call of a variants function imported from a .variants.ts module by default import',
      code: button('{other({ intent })}', 'import other from \'./Other.variants.ts\';'),
    },
    {
      name: 'a call of a const bound to a cva call',
      code: button('{localVariants({ intent })}', 'const localVariants = cva(\'flex\', { variants: {} });'),
    },
    {
      name: 'a call of a const bound to cva imported under another name',
      code: button('{localVariants()}', 'import { cva as variants } from \'class-variance-authority\';\nconst localVariants = variants(\'flex\');'),
    },
    {
      name: 'cn of a variants call and the passthrough className',
      code: button('{cn(buttonVariants({ intent }), className)}'),
    },
    {
      name: 'cn of two variants calls',
      code: button('{cn(buttonVariants({ intent }), localVariants())}', 'const localVariants = cva(\'flex\');'),
    },
    {
      name: 'cn of the passthrough className alone',
      code: button('{cn(className)}'),
    },
    {
      name: 'cn with no arguments, whose arguments are vacuously all allowed',
      code: button('{cn()}'),
    },
    {
      name: 'cn imported under another name',
      code: button('{merge(buttonVariants(), className)}', 'import { cn as merge } from \'../../lib/cn\';'),
    },
    {
      name: 'the bare passthrough className',
      code: button('{className}'),
    },
    {
      name: 'the passthrough className destructured with a default',
      code: `${IMPORTS}\nexport function Box({ className = undefined }: { className?: string }) {\n  return <div className={className} />;\n}`,
    },
    {
      name: 'the passthrough className of a first parameter that has a default',
      code: `${IMPORTS}\nexport function Box({ className }: { className?: string } = {}) {\n  return <div className={className} />;\n}`,
    },
    {
      name: 'the passthrough className of an arrow component passed to forwardRef',
      code: `${IMPORTS}\nexport const Box = forwardRef(({ className }: { className?: string }, ref) => <div ref={ref} className={cn(buttonVariants(), className)} />);`,
    },
    {
      name: 'the passthrough className in a nested callback',
      code: `${IMPORTS}\nexport function List({ items, className }: { items: string[]; className?: string }) {\n  return <ul>{items.map((item) => <li key={item} className={className}>{item}</li>)}</ul>;\n}`,
    },
    {
      name: 'an attribute other than className',
      code: button('{buttonVariants()}', 'const style = <div title="literal" data-class={`x`} />;'),
    },
    {
      name: 'a className key outside JSX',
      code: `${IMPORTS}\nexport const props = { className: 'px-2' };`,
    },
  ],
  invalid: [
    {
      name: 'a string literal attribute',
      code: button('"px-2"'),
      errors: [{ messageId: 'stringLiteral', line: ATTRIBUTE_LINE }],
    },
    {
      name: 'a string literal in braces',
      code: button('{\'px-2\'}'),
      errors: [{ messageId: 'stringLiteral' }],
    },
    {
      name: 'a template literal',
      code: button('{`px-2 ${className}`}'),
      errors: [{ messageId: 'templateLiteral', line: ATTRIBUTE_LINE }],
    },
    {
      name: 'a template literal with no substitution',
      code: button('{`px-2`}'),
      errors: [{ messageId: 'templateLiteral' }],
    },
    {
      name: 'a className with no value',
      code: `${IMPORTS}\nexport const box = <div className />;`,
      errors: [{ messageId: 'missingValue' }],
    },
    {
      name: 'a className holding an empty expression',
      code: button('{/* nothing */}'),
      errors: [{ messageId: 'missingValue' }],
    },
    {
      name: 'a JSX element as the value',
      code: button('<b />'),
      errors: [{ messageId: 'otherExpression' }],
    },
    {
      name: 'a conditional expression',
      code: button('{intent ? buttonVariants() : className}'),
      errors: [{ messageId: 'otherExpression' }],
    },
    {
      name: 'a logical expression',
      code: button('{className ?? buttonVariants()}'),
      errors: [{ messageId: 'otherExpression' }],
    },
    {
      name: 'a string concatenation',
      code: button('{buttonVariants() + \' px-2\'}'),
      errors: [{ messageId: 'otherExpression' }],
    },
    {
      name: 'a member access on props',
      code: `${IMPORTS}\nexport function Box(props: { className?: string }) {\n  return <div className={props.className} />;\n}`,
      errors: [{ messageId: 'otherExpression' }],
    },
    {
      name: 'a className const declared in the body',
      code: `${IMPORTS}\nexport function Box() {\n  const className = 'px-2';\n  return <div className={className} />;\n}`,
      errors: [{ messageId: 'otherExpression' }],
    },
    {
      name: 'a className destructured from props in the body',
      code: `${IMPORTS}\nexport function Box(props: { className?: string }) {\n  const { className } = props;\n  return <div className={className} />;\n}`,
      errors: [{ messageId: 'otherExpression' }],
    },
    {
      name: 'a plain parameter named className',
      code: `${IMPORTS}\nexport function box(className: string) {\n  return <div className={className} />;\n}`,
      errors: [{ messageId: 'otherExpression' }],
    },
    {
      name: 'a className bound from another prop key',
      code: `${IMPORTS}\nexport function Box({ classes: className }: { classes: string }) {\n  return <div className={className} />;\n}`,
      errors: [{ messageId: 'otherExpression' }],
    },
    {
      name: 'a className destructured from a second parameter',
      code: `${IMPORTS}\nexport const Box = forwardRef((props: object, { className }: { className: string }) => <div className={className} />);`,
      errors: [{ messageId: 'otherExpression' }],
    },
    {
      name: 'a renamed passthrough prop',
      code: `${IMPORTS}\nexport function Box({ className: extra }: { className?: string }) {\n  return <div className={extra} />;\n}`,
      errors: [{ messageId: 'otherExpression' }],
    },
    {
      name: 'an undeclared className',
      code: `${IMPORTS}\nexport const box = <div className={className} />;`,
      errors: [{ messageId: 'otherExpression' }],
    },
    {
      name: 'a call of a function that is no variants function',
      code: button('{classesFor(intent)}', 'const classesFor = (intent?: string) => `px-${intent}`;'),
      errors: [{ messageId: 'otherExpression' }],
    },
    {
      name: 'a call of a function imported from a module that is not a .variants module',
      code: button('{buttonClasses()}', 'import { buttonClasses } from \'./Button.classes\';'),
      errors: [{ messageId: 'otherExpression' }],
    },
    {
      name: 'a member call on a namespace import of a .variants module',
      code: button('{variants.buttonVariants()}', 'import * as variants from \'./Button.variants\';'),
      errors: [{ messageId: 'otherExpression' }],
    },
    {
      name: 'a call of a let bound to a cva call',
      code: button('{localVariants()}', 'let localVariants = cva(\'flex\');'),
      errors: [{ messageId: 'otherExpression' }],
    },
    {
      name: 'a call of a const bound to a local function named cva',
      code: 'const cva = (classes: string) => () => classes;\nconst localVariants = cva(\'px-2\');\nexport const box = <div className={localVariants()} />;',
      errors: [{ messageId: 'otherExpression' }],
    },
    {
      name: 'a call of a const bound to a global cva',
      code: 'const localVariants = cva(\'px-2\');\nexport const box = <div className={localVariants()} />;',
      errors: [{ messageId: 'otherExpression' }],
    },
    {
      name: 'a call of a const bound to cva by destructuring',
      code: button('{localVariants()}', 'const [localVariants] = [cva(\'flex\')];'),
      errors: [{ messageId: 'otherExpression' }],
    },
    {
      name: 'a call of a local function named cn',
      code: 'const cn = (...classes: string[]) => classes.join(\' \');\nexport const box = <div className={cn(\'px-2\')} />;',
      errors: [{ messageId: 'otherExpression' }],
    },
    {
      name: 'cn of a variants call and a string literal',
      code: button('{cn(buttonVariants(), \'px-2\')}'),
      errors: [{ messageId: 'cnArgument', column: 50 }],
    },
    {
      name: 'cn of a template literal',
      code: button('{cn(`px-${intent}`)}'),
      errors: [{ messageId: 'cnArgument' }],
    },
    {
      name: 'cn of a conditional class',
      code: button('{cn(buttonVariants(), intent === \'primary\' && \'ring\')}'),
      errors: [{ messageId: 'cnArgument' }],
    },
    {
      name: 'cn of an object of conditional classes',
      code: button('{cn(buttonVariants(), { ring: intent })}'),
      errors: [{ messageId: 'cnArgument' }],
    },
    {
      name: 'cn of a spread argument',
      code: button('{cn(...[buttonVariants()])}'),
      errors: [{ messageId: 'cnArgument' }],
    },
    {
      name: 'cn of a nested cn call',
      code: button('{cn(cn(buttonVariants()), className)}'),
      errors: [{ messageId: 'cnArgument' }],
    },
    {
      name: 'cn with two refused arguments, reporting each',
      code: button('{cn(\'px-2\', `py-2`)}'),
      errors: [{ messageId: 'cnArgument' }, { messageId: 'cnArgument' }],
    },
    {
      name: 'a literal on a component element',
      code: `${IMPORTS}\nexport const page = <Button className="mt-2" />;`,
      errors: [{ messageId: 'stringLiteral' }],
    },
  ],
});

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures');

/** The `cva-only-classname` messages for one fixture file, linted by the rule alone. */
async function lintFixture(filePath: string): Promise<readonly string[]> {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: {
      files: ['**/*.tsx'],
      languageOptions: {
        parser: tsParser,
        ecmaVersion: 'latest',
        sourceType: 'module',
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      plugins: { local: { rules: { [CVA_ONLY_CLASSNAME_RULE]: cvaOnlyClassname } } },
      rules: { [`local/${CVA_ONLY_CLASSNAME_RULE}`]: 'error' },
    },
  });
  const results = await eslint.lintText(readFileSync(filePath, 'utf8'), { filePath });
  return results.flatMap((result) => result.messages.map((message) => `${filePath}:${message.line} ${message.messageId}`));
}

describe('the structure fixtures', () => {
  test('the harness reports a literal className in a failing fixture', async () => {
    const failing = join(FIXTURES_DIR, 'build-lint', 'failing', 'library', 'src', 'atoms', 'Button', 'Button.tsx');

    const findings = await lintFixture(failing);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('stringLiteral');
  });

  test('every passing structure fixture component has zero findings', async () => {
    const structureDir = join(FIXTURES_DIR, 'structure');
    const files = readdirSync(structureDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.tsx'))
      .map((entry) => join(entry.parentPath, entry.name))
      .filter((file) => /[\\/]passing[\\/]/.test(file.slice(structureDir.length)));

    const findings = (await Promise.all(files.map(lintFixture))).flat();

    expect(files.length).toBeGreaterThan(0);
    expect(findings).toEqual([]);
  });
});
