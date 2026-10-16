import type { StoryCheck, StoryChecker, StorybookBuild, StorybookBuilder, StorybookBuildRequest } from './index.ts';

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { DEFAULT_LEVELS } from '../../../config/schema.ts';
import { type GateResult, gateResultSchema, LIBRARY_COMPONENT, SCANNED_ZERO_FILES_RULE } from '../result.ts';

import {
  DEFAULT_CHECK_PORT,
  runStoryHealthGate,
  STORY_HEALTH_GATE,
  STORY_RENDERS_CLEAN_RULE,
  STORYBOOK_BUILD_RULE,
} from './index.ts';
import { NO_CROSS_FOLDER_BARREL_RULE, NO_VITEST_IN_STORIES_RULE, PREVIEW_DETERMINISTIC_RULE } from './static.ts';

const FIXTURES = resolve(import.meta.dirname, '../fixtures');
const FAILING = join(FIXTURES, 'story-health/failing');

/** The story id and import path (relative to the library) of each story of the passing library. */
const PASSING_STORIES: Readonly<Record<string, string>> = {
  'dot--default': './src/particles/Dot/Dot.stories.tsx',
  'button--default': './src/atoms/Button/Button.stories.tsx',
  'button--hover': './src/atoms/Button/Button.stories.tsx',
  'toolbar--default': './src/molecules/Toolbar/Toolbar.stories.tsx',
  'header--default': './src/organisms/Header/Header.stories.tsx',
  'stack--default': './src/templates/Stack/Stack.stories.tsx',
  'pagelayout--default': './src/layouts/PageLayout/PageLayout.stories.tsx',
};

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A temp folder holding each file of `files`, keyed by POSIX path relative to it. */
function tempDir(files: Readonly<Record<string, string>> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'd2c-story-health-gate-'));

  dirs.push(dir);

  for (const [path, text] of Object.entries(files)) {
    const absolute = join(dir, path);

    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
  }

  return dir;
}

/** A temp copy of the fixture library at `fixture` (relative to the fixtures folder), so results never land in the repo. */
function copyLibrary(fixture: string): string {
  const dir = tempDir();

  cpSync(join(FIXTURES, fixture), dir, { recursive: true });

  return dir;
}

/** A fake builder and what it was asked: it writes an `index.json` listing `stories` (id to import path) and answers `outcome`. */
function fakeBuilder(stories: Readonly<Record<string, string>>, outcome: (request: StorybookBuildRequest) => StorybookBuild) {
  const requests: StorybookBuildRequest[] = [];
  const outputExisted: boolean[] = [];
  const build: StorybookBuilder = async (request) => {
    requests.push(request);
    outputExisted.push(existsSync(request.outputDir));

    const entries = Object.fromEntries(Object.entries(stories).flatMap(([id, importPath]) => [
      [id, { id, type: 'story', importPath, title: id, name: 'Story', tags: [] }],
      [`${id}-docs`, { id: `${id}-docs`, type: 'docs', importPath, title: id, name: 'Docs', storiesImports: [] }],
    ]));

    writeFileSync(join(request.outputDir, 'index.json'), JSON.stringify({ v: 5, entries }));

    return outcome(request);
  };

  return { build, requests, outputExisted };
}

/** A fake checker answering each id of the build's `index.json` with `errors[id]`, or none; and what it was asked. */
function fakeChecker(errors: Readonly<Record<string, readonly string[]>> = {}, extra: readonly StoryCheck[] = []) {
  const calls: { staticDir: string; port: number; hadIndex: boolean }[] = [];
  const check: StoryChecker = async (staticDir, port) => {
    const indexPath = join(staticDir, 'index.json');
    const hadIndex = existsSync(indexPath);

    calls.push({ staticDir, port, hadIndex });

    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { entries: Record<string, { id: string; type: string }> };
    const ids = Object.values(index.entries)
      .filter((entry) => entry.type === 'story')
      .map((entry) => entry.id);

    return [...ids.map((id) => ({ id, errors: errors[id] ?? [] })), ...extra];
  };

  return { check, calls };
}

/** Runs the gate with the default levels, project `passing`, and a clock that ticks 5ms a call. */
function run(targetDir: string, build: StorybookBuilder, check: StoryChecker, extra: { previewPath?: string; port?: number } = {}) {
  let tick = 0;

  return runStoryHealthGate({
    targetDir,
    levels: DEFAULT_LEVELS,
    project: 'passing',
    build,
    check,
    now: () => (tick += 5),
    ...extra,
  });
}

/** The story-health result written for `component` under `targetDir`. */
function readResult(targetDir: string, component: string): GateResult {
  return gateResultSchema.parse(JSON.parse(readFileSync(join(targetDir, 'gate-results', component, 'story-health.json'), 'utf8')));
}

/** The `[rule, file, line]` of every finding of `result`. */
function places(result: GateResult) {
  return result.findings.map((finding) => [finding.rule, finding.file, finding.line]);
}

/** A successful build that ran in `workingDir`. */
function builtIn(workingDir: string): () => StorybookBuild {
  return () => ({ ok: true, workingDir });
}

describe('runStoryHealthGate over the passing library', () => {
  test('passes every component when every story renders clean, writing no _library result', async () => {
    const targetDir = copyLibrary('passing/library');
    const builder = fakeBuilder(PASSING_STORIES, builtIn(targetDir));
    const checker = fakeChecker();

    const gate = await run(targetDir, builder.build, checker.check);

    expect(gate.status).toBe('pass');
    expect(gate.results.map((result) => [result.component, result.status])).toEqual([
      ['Dot', 'pass'],
      ['Button', 'pass'],
      ['Toolbar', 'pass'],
      ['Header', 'pass'],
      ['Stack', 'pass'],
      ['PageLayout', 'pass'],
    ]);
    expect(gate.scannedFiles).toBe(6);
    expect(existsSync(join(targetDir, 'gate-results', LIBRARY_COMPONENT))).toBe(false);
  });

  test('builds the project into a fresh temp folder, checks that build, and removes it', async () => {
    const targetDir = copyLibrary('passing/library');
    const builder = fakeBuilder(PASSING_STORIES, builtIn(targetDir));
    const checker = fakeChecker();

    await run(targetDir, builder.build, checker.check);

    const [request] = builder.requests;

    expect(builder.requests).toHaveLength(1);
    expect(request?.project).toBe('passing');
    expect(request?.outputDir.startsWith(tmpdir())).toBe(true);
    expect(request?.outputDir).not.toContain('storybook-static');
    expect(builder.outputExisted).toEqual([true]);
    expect(checker.calls).toEqual([{ staticDir: request?.outputDir, port: DEFAULT_CHECK_PORT, hadIndex: true }]);
    expect(existsSync(request?.outputDir ?? '')).toBe(false);
  });

  test('serves the build on the port it is given', async () => {
    const targetDir = copyLibrary('passing/library');
    const checker = fakeChecker();

    await run(targetDir, fakeBuilder(PASSING_STORIES, builtIn(targetDir)).build, checker.check, { port: 6123 });

    expect(checker.calls.map((call) => call.port)).toEqual([6123]);
  });

  test('writes exactly the results it returns, each with the run\'s duration', async () => {
    const targetDir = copyLibrary('passing/library');

    const gate = await run(targetDir, fakeBuilder(PASSING_STORIES, builtIn(targetDir)).build, fakeChecker().check);

    expect(gate.paths).toEqual(gate.results.map((result) => join(targetDir, 'gate-results', result.component, 'story-health.json')));
    expect(gate.paths.map((path) => gateResultSchema.parse(JSON.parse(readFileSync(path, 'utf8'))))).toEqual(gate.results);
    expect(gate.results.every((result) => result.gate === STORY_HEALTH_GATE && result.durationMs === 5)).toBe(true);
  });
});

describe('runStoryHealthGate rendered findings', () => {
  test('maps a story that errs to its component, naming the story file and its errors', async () => {
    const targetDir = copyLibrary('passing/library');
    const checker = fakeChecker({ 'button--hover': ['Warning: boom', 'pageerror: TypeError: x is undefined'] });

    const gate = await run(targetDir, fakeBuilder(PASSING_STORIES, builtIn(targetDir)).build, checker.check);

    expect(gate.status).toBe('fail');
    expect(gate.results.filter((result) => result.status === 'fail').map((result) => result.component)).toEqual(['Button']);
    const button = readResult(targetDir, 'Button');
    expect(places(button)).toEqual([[STORY_RENDERS_CLEAN_RULE, 'src/atoms/Button/Button.stories.tsx', null]]);
    expect(button.findings[0]?.message).toContain('button--hover');
    expect(button.findings[0]?.message).toContain('Warning: boom; pageerror: TypeError: x is undefined');
  });

  test('resolves import paths against the folder the build ran in', async () => {
    const targetDir = copyLibrary('passing/library');
    const workingDir = tempDir();
    const fromWorkingDir = Object.fromEntries(Object.entries(PASSING_STORIES)
      .map(([id, importPath]) => [id, relative(workingDir, join(targetDir, importPath))]));
    const checker = fakeChecker({ 'toolbar--default': ['boom'] });

    await run(targetDir, fakeBuilder(fromWorkingDir, builtIn(workingDir)).build, checker.check);

    expect(places(readResult(targetDir, 'Toolbar'))).toEqual([[STORY_RENDERS_CLEAN_RULE, 'src/molecules/Toolbar/Toolbar.stories.tsx', null]]);
  });

  test('gives a story outside the library, or one the index does not list, to _library with no file', async () => {
    const targetDir = copyLibrary('passing/library');
    const stories = { ...PASSING_STORIES, 'harness-fixture--renders': '../harness/fixtures/Fixture.stories.tsx' };
    const checker = fakeChecker({ 'harness-fixture--renders': ['boom'] }, [{ id: 'ghost--story', errors: ['gone'] }]);

    const gate = await run(targetDir, fakeBuilder(stories, builtIn(targetDir)).build, checker.check);

    expect(gate.results.map((result) => [result.component, result.status]).at(-1)).toEqual([LIBRARY_COMPONENT, 'fail']);
    const library = readResult(targetDir, LIBRARY_COMPONENT);
    expect(places(library)).toEqual([
      [STORY_RENDERS_CLEAN_RULE, null, null],
      [STORY_RENDERS_CLEAN_RULE, null, null],
    ]);
    expect(library.findings[0]?.message).toContain('../harness/fixtures/Fixture.stories.tsx, outside the library');
    expect(library.findings[1]?.message).toContain('ghost--story');
    expect(library.findings[1]?.message).toContain('does not name');
  });

  test('fails with one _library finding carrying the build output when the build fails, and checks nothing', async () => {
    const targetDir = copyLibrary('passing/library');
    const builder = fakeBuilder(PASSING_STORIES, () => ({ ok: false, output: `exited with status 1: ${'x'.repeat(3000)}Rollup failed to resolve "./Missing"` }));
    const checker = fakeChecker();

    const gate = await run(targetDir, builder.build, checker.check);

    expect(gate.status).toBe('fail');
    expect(checker.calls).toEqual([]);
    expect(existsSync(builder.requests[0]?.outputDir ?? '')).toBe(false);
    const library = readResult(targetDir, LIBRARY_COMPONENT);
    expect(places(library)).toEqual([[STORYBOOK_BUILD_RULE, null, null]]);
    expect(library.findings[0]?.message).toMatch(/Rollup failed to resolve "\.\/Missing"$/);
    expect(library.findings[0]?.message.length).toBeLessThan(2100);
    expect(readResult(targetDir, 'Button').status).toBe('pass');
  });

  test('fails with scanned-zero-files when the build renders no story from the library', async () => {
    const targetDir = copyLibrary('passing/library');
    const stories = { 'harness-fixture--renders': '../harness/fixtures/Fixture.stories.tsx' };

    const gate = await run(targetDir, fakeBuilder(stories, builtIn(targetDir)).build, fakeChecker().check);

    expect(gate.status).toBe('fail');
    const library = readResult(targetDir, LIBRARY_COMPONENT);
    expect(places(library)).toEqual([[SCANNED_ZERO_FILES_RULE, null, null]]);
    expect(library.findings[0]?.message).toContain('the built Storybook');
  });

  test('removes the temp build and rejects when the checker throws', async () => {
    const targetDir = copyLibrary('passing/library');
    const builder = fakeBuilder(PASSING_STORIES, builtIn(targetDir));
    const check: StoryChecker = async () => {
      throw new Error('chromium is missing');
    };

    await expect(run(targetDir, builder.build, check)).rejects.toThrow('chromium is missing');
    expect(existsSync(builder.requests[0]?.outputDir ?? '')).toBe(false);
  });
});

describe('runStoryHealthGate static findings', () => {
  test('puts each static finding in its component, before the rendered ones, and the preview\'s under _library', async () => {
    const targetDir = copyLibrary('story-health/failing/library');
    const stories = {
      'dot--default': './src/particles/Dot/Dot.stories.tsx',
      'button--default': './src/atoms/Button/Button.stories.tsx',
      'toolbar--default': './src/molecules/Toolbar/Toolbar.stories.tsx',
    };
    const checker = fakeChecker({ 'button--default': ['vitest crashed the preview'] });

    const gate = await run(targetDir, fakeBuilder(stories, builtIn(targetDir)).build, checker.check, { previewPath: join(FAILING, 'preview.ts') });

    expect(gate.results.map((result) => [result.component, result.status])).toEqual([
      ['Dot', 'pass'],
      ['Button', 'fail'],
      ['Toolbar', 'fail'],
      [LIBRARY_COMPONENT, 'fail'],
    ]);
    expect(places(readResult(targetDir, 'Button'))).toEqual([
      [NO_VITEST_IN_STORIES_RULE, 'src/atoms/Button/Button.stories.tsx', 3],
      [STORY_RENDERS_CLEAN_RULE, 'src/atoms/Button/Button.stories.tsx', null],
    ]);
    expect(places(readResult(targetDir, 'Toolbar'))).toEqual([
      [NO_CROSS_FOLDER_BARREL_RULE, 'src/molecules/Toolbar/Toolbar.stories.tsx', 4],
      [NO_CROSS_FOLDER_BARREL_RULE, 'src/molecules/Toolbar/Toolbar.stories.tsx', 5],
    ]);
    expect(places(readResult(targetDir, LIBRARY_COMPONENT))).toEqual([[PREVIEW_DETERMINISTIC_RULE, null, null]]);
  });
});

describe('runStoryHealthGate on zero story files', () => {
  test('fails an empty library with scanned-zero-files under _library, building nothing', async () => {
    const targetDir = tempDir();
    const builder = fakeBuilder({}, builtIn(targetDir));
    const checker = fakeChecker();

    const gate = await run(targetDir, builder.build, checker.check);

    expect(gate.status).toBe('fail');
    expect(gate.scannedFiles).toBe(0);
    expect(gate.results.map((result) => result.component)).toEqual([LIBRARY_COMPONENT]);
    expect(places(readResult(targetDir, LIBRARY_COMPONENT))).toEqual([[SCANNED_ZERO_FILES_RULE, null, null]]);
    expect(builder.requests).toEqual([]);
    expect(checker.calls).toEqual([]);
  });

  test('fails a library whose components hold no story file, passing each component', async () => {
    const targetDir = tempDir({ 'src/atoms/Button/Button.tsx': 'export const Button = () => null;\n' });
    const builder = fakeBuilder({}, builtIn(targetDir));

    const gate = await run(targetDir, builder.build, fakeChecker().check);

    expect(gate.results.map((result) => [result.component, result.status])).toEqual([
      ['Button', 'pass'],
      [LIBRARY_COMPONENT, 'fail'],
    ]);
    expect(readResult(targetDir, LIBRARY_COMPONENT).findings[0]?.message).toContain('story files of src');
    expect(builder.requests).toEqual([]);
  });

  test('removes a _library result left by an earlier run once a run finds nothing there', async () => {
    const targetDir = copyLibrary('passing/library');
    const harnessOnly = { 'harness-fixture--renders': '../harness/fixtures/Fixture.stories.tsx' };

    await run(targetDir, fakeBuilder(harnessOnly, builtIn(targetDir)).build, fakeChecker().check);
    expect(existsSync(join(targetDir, 'gate-results', LIBRARY_COMPONENT, 'story-health.json'))).toBe(true);

    const gate = await run(targetDir, fakeBuilder(PASSING_STORIES, builtIn(targetDir)).build, fakeChecker().check);

    expect(gate.status).toBe('pass');
    expect(existsSync(join(targetDir, 'gate-results', LIBRARY_COMPONENT, 'story-health.json'))).toBe(false);
  });
});
