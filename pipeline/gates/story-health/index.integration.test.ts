/**
 * Integration test for the story health gate: builds the real managed
 * Storybook and renders its stories in headless Chromium, over the passing
 * fixture library and over a fixture whose story logs a console error.
 *
 * The harness reads its project from `projects/<slug>.json` under the repo
 * root, and resolves `react` and the rest from the repo's `node_modules`, so
 * each case copies the fixture library into a folder under the repo's
 * gitignored `.tmp/` and writes a throwaway, gitignored `projects/<slug>.json`
 * pointing at the copy. Both are removed afterwards, even if an assertion
 * fails, and the copy keeps `gate-results/` out of the fixtures.
 *
 * @packageDocumentation
 */

import type { StoryHealthGateRun } from './index.ts';

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { DEFAULT_LEVELS } from '../../../config/schema.ts';
import { gateResultSchema, LIBRARY_COMPONENT } from '../result.ts';

import { runStoryHealthGate, STORY_HEALTH_GATE, STORY_RENDERS_CLEAN_RULE } from './index.ts';

const REPO = resolve(import.meta.dirname, '../../..');
const FIXTURES = resolve(import.meta.dirname, '../fixtures');
const PASSING_LIBRARY = join(FIXTURES, 'passing/library');
const CONSOLE_ERROR_LIBRARY = join(FIXTURES, 'story-health/console-error/library');

/** The longest a build of the Storybook and a render of its stories may take, in milliseconds. */
const RUN_TIMEOUT_MS = 240_000;

const created: string[] = [];

afterEach(() => {
  for (const path of created.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

/** What a run over a copied fixture library needs: where the copy is and the project that builds it. */
interface Sandbox {
  readonly targetDir: string;
  readonly slug: string;
}

/**
 * Copies `library` into a fresh folder under `.tmp/` and writes a project
 * config for it, both removed after the test.
 */
function sandbox(label: string, library: string): Sandbox {
  const slug = `integration-story-health-${label}-${crypto.randomUUID()}`;
  const root = join(REPO, '.tmp', slug);
  const targetDir = join(root, 'library');
  const sourceDir = join(root, 'source');
  const projectFile = join(REPO, 'projects', `${slug}.json`);

  created.push(root, projectFile);
  mkdirSync(sourceDir, { recursive: true });
  cpSync(library, targetDir, { recursive: true });
  writeFileSync(projectFile, JSON.stringify({
    slug,
    source: { dir: relative(REPO, sourceDir) },
    target: { dir: relative(REPO, targetDir) },
  }));

  return { targetDir, slug };
}

/** Runs the story health gate, with its real builder and checker, over `library`. */
function runGate(label: string, library: string): Promise<{ run: StoryHealthGateRun; box: Sandbox }> {
  const box = sandbox(label, library);

  return runStoryHealthGate({ targetDir: box.targetDir, levels: DEFAULT_LEVELS, project: box.slug })
    .then((run) => ({ run, box }));
}

describe('story health gate, building the managed Storybook', () => {
  test('passes on the passing fixture library, writing a pass for every component', async () => {
    const { run, box } = await runGate('passing', PASSING_LIBRARY);

    expect(run.results.flatMap((result) => result.findings)).toEqual([]);
    expect(run.status).toBe('pass');
    expect(run.results.map((result) => result.component)).toEqual(
      ['Dot', 'Button', 'Toolbar', 'Header', 'Stack', 'PageLayout'],
    );
    expect(run.results.every((result) => result.status === 'pass')).toBe(true);

    const written = gateResultSchema.parse(JSON.parse(readFileSync(
      join(box.targetDir, 'gate-results', 'Button', `${STORY_HEALTH_GATE}.json`),
      'utf8',
    )));

    expect(written.status).toBe('pass');
  }, RUN_TIMEOUT_MS);

  test('fails on a story that logs a console error, naming the story file', async () => {
    const { run, box } = await runGate('console-error', CONSOLE_ERROR_LIBRARY);
    const storyFile = 'src/atoms/Button/Button.stories.tsx';
    const button = run.results.find((result) => result.component === 'Button');

    expect(run.status).toBe('fail');
    expect(run.results.some((result) => result.component === LIBRARY_COMPONENT)).toBe(false);
    expect(button?.status).toBe('fail');
    expect(button?.findings).toHaveLength(1);

    const [finding] = button?.findings ?? [];

    expect(finding?.rule).toBe(STORY_RENDERS_CLEAN_RULE);
    expect(finding?.file).toBe(storyFile);
    expect(finding?.message).toContain('button--broken');
    expect(finding?.message).toContain(storyFile);
    expect(finding?.message).toContain('this story logs a console error when it renders');
    expect(finding?.message).not.toContain('button--default');

    const written = gateResultSchema.parse(JSON.parse(readFileSync(
      join(box.targetDir, 'gate-results', 'Button', `${STORY_HEALTH_GATE}.json`),
      'utf8',
    )));

    expect(written.findings.map((each) => each.file)).toEqual([storyFile]);
  }, RUN_TIMEOUT_MS);
});
