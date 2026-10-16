import { describe, expect, test } from 'vitest';

import { PROJECT_STYLE_MODULE, projectStylePlugin, projectStyleSource } from './project-style';

const STYLE_ENTRY = '/repo/components/homepage/src/styles/index.css';

/** Calls a plugin hook given as a plain function, as this plugin's are. */
function callHook(hook: unknown, ...args: unknown[]): unknown {
  if (typeof hook !== 'function') {
    throw new TypeError('expected the hook to be a function');
  }

  return hook.call(undefined, ...args);
}

describe('projectStyleSource', () => {
  test('is empty without a style entry', () => {
    expect(projectStyleSource(undefined)).toBe('');
  });

  test('imports the style entry for its side effects', () => {
    expect(projectStyleSource(STYLE_ENTRY)).toBe(`import "${STYLE_ENTRY}";\n`);
  });
});

describe('projectStylePlugin', () => {
  test('resolves the virtual module and loads the style import', () => {
    const plugin = projectStylePlugin(STYLE_ENTRY);
    const resolved = callHook(plugin.resolveId, PROJECT_STYLE_MODULE, undefined, {});

    expect(resolved).toBe(`\0${PROJECT_STYLE_MODULE}`);
    expect(callHook(plugin.load, resolved)).toBe(projectStyleSource(STYLE_ENTRY));
  });

  test('loads an empty module without a style entry', () => {
    const plugin = projectStylePlugin(undefined);
    const resolved = callHook(plugin.resolveId, PROJECT_STYLE_MODULE, undefined, {});

    expect(callHook(plugin.load, resolved)).toBe('');
  });

  test('leaves every other id to the other plugins', () => {
    const plugin = projectStylePlugin(STYLE_ENTRY);

    expect(callHook(plugin.resolveId, './index.css', undefined, {})).toBeUndefined();
    expect(callHook(plugin.load, PROJECT_STYLE_MODULE)).toBeUndefined();
  });
});
