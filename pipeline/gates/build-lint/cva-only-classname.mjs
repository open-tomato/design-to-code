/**
 * The `cva-only-classname` ESLint rule: a component's classes come from its
 * `cva` variants, so a JSX `className` value may only be one of three shapes.
 *
 * Allowed:
 *
 * - a variants call: a call of a function bound, in this file, either by a
 *   `const` declaration initialised with a `cva(...)` call or by an import
 *   from a `.variants` module (the library's colocated `<Name>.variants.ts`);
 * - a `cn(...)` call whose every argument is a variants call or the
 *   passthrough `className` prop;
 * - the passthrough `className` prop itself, bare.
 *
 * Refused: a string literal, a template literal, and any other expression,
 * including `cn(...)` with any other argument and a valueless `className`.
 *
 * `cva` and `cn` count only as imported bindings whose imported name is
 * `cva` or `cn` (under any local name), so a local function of that name
 * passes nothing. The passthrough prop is a `className` identifier bound by
 * destructuring the `className` key of a function's first parameter, as in
 * `function Button({ className })`; a `className` declared any other way is
 * refused. Only JSX attributes named `className` are checked: spread
 * attributes and `createElement` props are not.
 *
 * Plain ESM JavaScript with JSDoc types, so an `eslint.config.mjs` loads it
 * under plain Node.
 *
 * @packageDocumentation
 */

/** The rule name, as registered in a config and written in each finding. */
export const CVA_ONLY_CLASSNAME_RULE = 'cva-only-classname';

/** The imported name of the variants factory. */
const CVA_NAME = 'cva';

/** The imported name of the class merger. */
const CN_NAME = 'cn';

/** The prop name the rule checks and lets through. */
const CLASS_NAME = 'className';

/** A module specifier naming a colocated variants module, with or without its extension. */
const VARIANTS_MODULE = /\.variants(\.[cm]?[jt]sx?)?$/;

/** What every refusal message tells the author to do instead. */
const ADVICE = 'declare the classes in a cva variants call and pass its result, merged with the passthrough className through cn';

/**
 * @typedef {import('eslint').Rule.Node} Node
 * @typedef {import('eslint').Scope.Scope} Scope
 * @typedef {import('eslint').Scope.Variable} Variable
 */

/**
 * The variable `name` resolves to from `scope`, or `undefined` for a global.
 *
 * @param {Scope} scope - The scope the name is read in.
 * @param {string} name - The identifier's name.
 * @returns {Variable | undefined} The nearest binding of `name`.
 */
function resolve(scope, name) {
  for (let current = scope; current; current = current.upper) {
    const variable = current.set.get(name);

    if (variable) {
      return variable;
    }
  }

  return undefined;
}

/**
 * Whether `variable` is a named import whose imported name is `importedName`.
 *
 * @param {Variable | undefined} variable - The binding to inspect.
 * @param {string} importedName - The name it must be imported under.
 * @returns {boolean} `true` for `import { importedName [as x] } from '…'`.
 */
function isImportOf(variable, importedName) {
  return variable?.defs.some(({ type, node }) => type === 'ImportBinding'
    && node.type === 'ImportSpecifier'
    && node.imported.type === 'Identifier'
    && node.imported.name === importedName) ?? false;
}

/**
 * Whether `variable` holds a variants function: a `const` bound to a `cva`
 * call, or a default or named import from a `.variants` module.
 *
 * @param {Variable | undefined} variable - The binding to inspect.
 * @param {Scope} scope - The scope the binding is called in.
 * @returns {boolean} `true` when calling it is a variants call.
 */
function isVariantsFunction(variable, scope) {
  return variable?.defs.some((def) => {
    if (def.type === 'ImportBinding') {
      return def.node.type !== 'ImportNamespaceSpecifier'
        && VARIANTS_MODULE.test(String(def.parent.source.value));
    }

    return def.type === 'Variable'
      && def.parent.kind === 'const'
      && def.node.id.type === 'Identifier'
      && def.node.init?.type === 'CallExpression'
      && def.node.init.callee.type === 'Identifier'
      && isImportOf(resolve(scope, def.node.init.callee.name), CVA_NAME);
  }) ?? false;
}

/**
 * Whether `node` is a call of a variants function.
 *
 * @param {Node} node - The expression to inspect.
 * @param {Scope} scope - The scope it is evaluated in.
 * @returns {boolean} `true` for `someVariants(…)`.
 */
function isVariantsCall(node, scope) {
  return node.type === 'CallExpression'
    && node.callee.type === 'Identifier'
    && isVariantsFunction(resolve(scope, node.callee.name), scope);
}

/**
 * Whether `node` is the component's passthrough `className` prop: an
 * identifier named `className` bound by destructuring the `className` key,
 * with or without a default, from its function's first parameter.
 *
 * @param {Node} node - The expression to inspect.
 * @param {Scope} scope - The scope it is evaluated in.
 * @returns {boolean} `true` for the bare passthrough prop.
 */
function isPassthroughClassName(node, scope) {
  if (node.type !== 'Identifier' || node.name !== CLASS_NAME) {
    return false;
  }

  return resolve(scope, CLASS_NAME)?.defs.some(({ type, name, node: fn }) => {
    if (type !== 'Parameter') {
      return false;
    }

    const binding = name.parent?.type === 'AssignmentPattern'
      ? name.parent
      : name;
    const property = binding.parent;
    const pattern = property?.parent;
    const [first] = fn.params;
    const firstPattern = first?.type === 'AssignmentPattern'
      ? first.left
      : first;

    return property?.type === 'Property'
      && property.value === binding
      && !property.computed
      && property.key.type === 'Identifier'
      && property.key.name === CLASS_NAME
      && pattern?.type === 'ObjectPattern'
      && pattern === firstPattern;
  }) ?? false;
}

/**
 * Whether `node` is a `cn(…)` call.
 *
 * @param {Node} node - The expression to inspect.
 * @param {Scope} scope - The scope it is evaluated in.
 * @returns {boolean} `true` for a call of the imported `cn`.
 */
function isCnCall(node, scope) {
  return node.type === 'CallExpression'
    && node.callee.type === 'Identifier'
    && isImportOf(resolve(scope, node.callee.name), CN_NAME);
}

/**
 * The message id refusing a `className` expression that is neither a
 * variants call, a `cn` call nor the passthrough prop.
 *
 * @param {Node} node - The refused expression.
 * @returns {'stringLiteral' | 'templateLiteral' | 'otherExpression'} The id.
 */
function refusal(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return 'stringLiteral';
  }

  return node.type === 'TemplateLiteral'
    ? 'templateLiteral'
    : 'otherExpression';
}

/**
 * The rule. It reports on the attribute's value, or on each refused `cn`
 * argument, so a finding's line is the offending expression's.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
export const cvaOnlyClassname = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require a className to come from cva variants, merged with the passthrough className through cn',
    },
    schema: [],
    messages: {
      stringLiteral: `className must not be a string literal: ${ADVICE}.`,
      templateLiteral: `className must not be a template literal: ${ADVICE}.`,
      otherExpression: `className must be a variants call, cn(...) of variants calls and the passthrough className, or the passthrough className: ${ADVICE}.`,
      cnArgument: `cn(...) in a className may merge only variants calls and the passthrough className: ${ADVICE}.`,
      missingValue: `className must have a value: ${ADVICE}.`,
    },
  },
  create(context) {
    const { sourceCode } = context;

    return {
      /** @param {any} attribute - A JSX attribute; ESLint's node types cover ESTree only, not JSX. */
      JSXAttribute(attribute) {
        if (attribute.name.type !== 'JSXIdentifier' || attribute.name.name !== CLASS_NAME) {
          return;
        }

        const { value } = attribute;

        if (value === null) {
          context.report({ node: attribute, messageId: 'missingValue' });

          return;
        }

        if (value.type !== 'JSXExpressionContainer') {
          context.report({ node: value, messageId: refusal(value) });

          return;
        }

        const expression = value.expression;
        const scope = sourceCode.getScope(attribute);

        if (expression.type === 'JSXEmptyExpression') {
          context.report({ node: value, messageId: 'missingValue' });

          return;
        }

        if (isVariantsCall(expression, scope) || isPassthroughClassName(expression, scope)) {
          return;
        }

        if (!isCnCall(expression, scope)) {
          context.report({ node: expression, messageId: refusal(expression) });

          return;
        }

        for (const argument of expression.arguments) {
          if (!isVariantsCall(argument, scope) && !isPassthroughClassName(argument, scope)) {
            context.report({ node: argument, messageId: 'cnArgument' });
          }
        }
      },
    };
  },
};
