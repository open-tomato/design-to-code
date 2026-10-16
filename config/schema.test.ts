import type { ProjectConfig, ProjectConfigInput } from './schema';

import { describe, expect, test } from 'vitest';

import { projectConfigSchema } from './schema';

const MINIMAL: ProjectConfigInput = {
  slug: 'homepage',
  source: { dir: 'design/homepage' },
};

/** The dotted paths of every issue a failed parse reports, sorted. */
function failingPaths(input: unknown): string[] {
  const result = projectConfigSchema.safeParse(input);

  if (result.success) {
    throw new Error(`expected ${JSON.stringify(input)} to fail`);
  }

  return result.error.issues.map((issue) => issue.path.join('.')).sort();
}

describe('projectConfigSchema', () => {
  test('rejects {} on exactly slug and source.dir', () => {
    expect(failingPaths({})).toEqual(['slug', 'source.dir']);
  });

  test('gives the minimal valid config every default', () => {
    const expected: ProjectConfig = {
      slug: 'homepage',
      name: 'homepage',
      source: { dir: 'design/homepage' },
      target: { dir: 'components/homepage', kind: 'component-library' },
      baselineDir: 'baselines/homepage',
      storybook: { mode: 'managed' },
      levels: ['particles', 'atoms', 'molecules', 'organisms', 'templates', 'layouts'],
    };

    expect(projectConfigSchema.parse(MINIMAL)).toStrictEqual(expected);
  });

  test('rejects an unknown storybook.mode on that field', () => {
    const input = { ...MINIMAL, storybook: { mode: 'embedded' } };

    expect(failingPaths(input)).toEqual(['storybook.mode']);
  });

  test('accepts detached, which only the loader refuses', () => {
    const input = { ...MINIMAL, storybook: { mode: 'detached' } };

    expect(projectConfigSchema.parse(input).storybook.mode).toBe('detached');
  });

  test('keeps explicit values over the slug-derived defaults', () => {
    const input: ProjectConfigInput = {
      ...MINIMAL,
      name: 'Homepage',
      target: { dir: 'components/site' },
      baselineDir: 'baselines/site',
    };

    const config = projectConfigSchema.parse(input);

    expect(config.name).toBe('Homepage');
    expect(config.target).toEqual({ dir: 'components/site', kind: 'component-library' });
    expect(config.baselineDir).toBe('baselines/site');
  });

  test('keeps every optional field it is given', () => {
    const optional = {
      source: { dir: 'design/homepage', shareLink: 'https://example.com/share/abc' },
      pages: { keep: ['Home'], discard: ['Scratch'] },
      viewports: [{ name: 'desktop', width: 1280, height: 900 }],
      tolerance: { designVsCode: 0.001 },
    };

    expect(projectConfigSchema.parse({ ...MINIMAL, ...optional })).toMatchObject(optional);
  });

  test('keeps a given levels list in its order', () => {
    const levels = ['base', 'composite'];

    expect(projectConfigSchema.parse({ ...MINIMAL, levels }).levels).toEqual(levels);
  });

  test.each([
    ['a slug with a path separator', { slug: '../x' }, 'slug'],
    ['an empty source.dir', { source: { dir: '' } }, 'source.dir'],
    ['a shareLink that is not a URL', { source: { dir: 'd', shareLink: 'nope' } }, 'source.shareLink'],
    ['an unknown target.kind', { target: { kind: 'app' } }, 'target.kind'],
    ['a fractional viewport width', { viewports: [{ name: 'm', width: 1.5, height: 1 }] }, 'viewports.0.width'],
    ['an empty levels list', { levels: [] }, 'levels'],
    ['an empty level name', { levels: ['atoms', ''] }, 'levels.1'],
    ['a repeated level', { levels: ['atoms', 'atoms'] }, 'levels'],
    ['a tolerance above 1', { tolerance: { designVsCode: 2 } }, 'tolerance.designVsCode'],
  ])('rejects %s on its dotted path', (_label, override, path) => {
    expect(failingPaths({ ...MINIMAL, ...override })).toEqual([path]);
  });
});
