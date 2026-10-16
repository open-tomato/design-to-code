/**
 * The story health gate: runs the browser-free checks of `./static.ts`,
 * builds the managed Storybook and renders every story of the build with
 * the story doctor's `checkStories`, and writes what they found as
 * `story-health` gate results.
 *
 * The build is `storybook build -c harness/.storybook` run in the repo root
 * under the running JavaScript runtime, with `D2C_PROJECT` set to the
 * project, into a fresh temp folder that is removed once the stories are
 * checked: never `storybook-static/`, so a gate run never touches a build a
 * person made. The builder and the checker are injectable (see
 * {@link StoryHealthGateOptions}), so the gate's logic runs without a
 * browser or a build.
 *
 * Each story that logs a console error, throws a page error or shows the
 * error overlay is one {@link STORY_RENDERS_CLEAN_RULE} finding. Its story
 * id maps back to its file through the build's `index.json`, whose
 * `importPath` is relative to the folder the build ran in; the file goes to
 * the component whose folder holds it, POSIX-relative to `target.dir`, with
 * no line. A story whose file lies outside `target.dir`, such as a harness
 * fixture, or whose id the index does not list, goes to `_library`, its
 * message naming the import path or the id. A build that exits non-zero is
 * one `_library` {@link STORYBOOK_BUILD_RULE} finding carrying the end of
 * its output, and no story is checked.
 *
 * The files this gate scans are story files. When the library's component
 * folders hold none, the gate fails with a `scanned-zero-files` finding
 * under `_library` and runs neither a check nor the build, so an empty or
 * misplaced library never reads as a pass. When they hold some but the
 * built Storybook lists no story from `target.dir`, as when `D2C_PROJECT`
 * names another project, the rendered check scanned nothing, and the gate
 * fails with a `_library` `scanned-zero-files` finding too.
 *
 * Every listed component gets one `story-health.json` under
 * `<target.dir>/gate-results/<component>/`: a `fail` carrying its findings
 * (static first, then rendered) when it has any, a `pass` otherwise. Two
 * components sharing a name in different levels share one result file,
 * their findings merged. `_library` gets one only when it holds a finding;
 * a `_library` result left by an earlier run is removed when this run finds
 * nothing there. Every result carries the whole run's duration as its
 * `durationMs`.
 *
 * @packageDocumentation
 */

import type { LibraryComponent } from '../library.ts';
import type { GateFinding, GateResult } from '../result.ts';
import type { StoryHealthFinding } from './static.ts';

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';

import { z } from 'zod';

import { PROJECT_ENV_VAR, REPO_ROOT } from '../../../config/load.ts';
import { checkStories } from '../../../scripts/check-stories.mjs';
import { owningComponent } from '../build-lint/index.ts';
import { groupFindings, targetRelative, toResult } from '../findings.ts';
import { listLibrary, LIBRARY_SOURCE_DIR } from '../library.ts';
import { gateResultPath, LIBRARY_COMPONENT, scannedZeroFilesFinding, writeGateResult } from '../result.ts';

import { runStaticChecks } from './static.ts';

/** The gate name, as written in results and result file names. */
export const STORY_HEALTH_GATE = 'story-health';

/** The rule of the finding for a story that logs an error when rendered in the built Storybook. */
export const STORY_RENDERS_CLEAN_RULE = 'story-renders-clean';

/** The rule of the finding for a Storybook build that exits non-zero. */
export const STORYBOOK_BUILD_RULE = 'storybook-build';

/** The managed Storybook's config folder, which every project builds with. */
export const HARNESS_CONFIG_DIR = join(REPO_ROOT, 'harness', '.storybook');

/** The port the checker serves the build on when none is given: 0, any free port. */
export const DEFAULT_CHECK_PORT = 0;

/** The most characters of a failed build's output a finding's message carries. */
const MAX_BUILD_OUTPUT = 2000;

/** A story file's name: `<anything>.stories.` and a script extension, as `./static.ts` reads it. */
const STORY_FILE = /\.stories\.(?:[cm]?[jt]s|[jt]sx)$/;

/** One story the checker rendered: its id and its errors, empty when it renders clean. */
export interface StoryCheck {
  /** The story id, as in the build's `index.json`. */
  readonly id: string;
  /** Its errors, in the order seen. */
  readonly errors: readonly string[];
}

/** Renders every story of the build in `staticDir`, served on `port`, as `checkStories` does. */
export type StoryChecker = (staticDir: string, port: number) => Promise<readonly StoryCheck[]>;

/** What a builder is asked to build. */
export interface StorybookBuildRequest {
  /** The project slug, set as `D2C_PROJECT` for the build. */
  readonly project: string;
  /** The empty temp folder the build writes into. */
  readonly outputDir: string;
}

/** How a build went: its working folder when it succeeded, its output when it did not. */
export type StorybookBuild =
  | {
    /** The build succeeded. */
    readonly ok: true;
    /** The folder the build ran in, which `index.json`'s `importPath`s are relative to. */
    readonly workingDir: string;
  }
  | {
    /** The build exited non-zero. */
    readonly ok: false;
    /** What it printed, for the finding's message. */
    readonly output: string;
  };

/**
 * Builds the managed Storybook for a project.
 *
 * @throws when the build cannot be started or is killed; a build that
 *   exits non-zero resolves to `ok: false` instead.
 */
export type StorybookBuilder = (request: StorybookBuildRequest) => Promise<StorybookBuild>;

/** What the story health gate reads. */
export interface StoryHealthGateOptions {
  /** The library's root, the config's `target.dir`; results are written under it. */
  readonly targetDir: string;
  /** The level folder names, lowest first: the config's `levels`. */
  readonly levels: readonly string[];
  /** The project slug the Storybook is built for. */
  readonly project: string;
  /** The preview `preview-deterministic` reads; the harness's own when left out. */
  readonly previewPath?: string;
  /** Builds the Storybook; {@link buildStorybook} when left out. */
  readonly build?: StorybookBuilder;
  /** Renders the built stories; `checkStories` from `scripts/check-stories.mjs` when left out. */
  readonly check?: StoryChecker;
  /** The port the checker serves the build on; {@link DEFAULT_CHECK_PORT} when left out. */
  readonly port?: number;
  /** The clock, in milliseconds, used for `durationMs`; `performance.now` when left out. */
  readonly now?: () => number;
}

/** What one run of the story health gate wrote. */
export interface StoryHealthGateRun {
  /** `fail` when any result failed, `pass` otherwise. */
  readonly status: 'pass' | 'fail';
  /** Every result written, listed components first in library order, then `_library`. */
  readonly results: readonly GateResult[];
  /** The absolute path of each result, in the order of `results`. */
  readonly paths: readonly string[];
  /** The number of story files in the library's component folders. */
  readonly scannedFiles: number;
}

/**
 * The parts of a Storybook build's `index.json` the gate reads. Storybook
 * writes more fields than these, so the objects are loose rather than
 * strict: an extra field is Storybook's, not a mistake.
 */
const storybookIndexSchema = z.looseObject({
  entries: z.record(z.string(), z.looseObject({
    id: z.string(),
    type: z.string(),
    importPath: z.string(),
  })),
});

/** The path of the Storybook CLI's entry script, from the `storybook` package's `bin`. */
function storybookCli(): string {
  const manifestPath = createRequire(import.meta.url).resolve('storybook/package.json');
  const manifest = z.looseObject({ bin: z.string() }).parse(JSON.parse(readFileSync(manifestPath, 'utf8')));

  return join(dirname(manifestPath), manifest.bin);
}

/**
 * Builds the managed Storybook for `request.project` into
 * `request.outputDir`: `storybook build -c harness/.storybook` in the repo
 * root, under the running JavaScript runtime, with `D2C_PROJECT` set.
 *
 * @throws when the build cannot be started or is killed by a signal.
 */
export const buildStorybook: StorybookBuilder = (request) => new Promise((resolveBuild, reject) => {
  const args = [storybookCli(), 'build', '-c', HARNESS_CONFIG_DIR, '-o', request.outputDir, '--quiet', '--disable-telemetry'];
  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, [PROJECT_ENV_VAR]: request.project },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks: Buffer[] = [];

  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.once('error', reject);
  child.once('close', (code, signal) => {
    if (code === null) {
      reject(new Error(`storybook build was killed by ${signal ?? 'a signal'}`));

      return;
    }

    resolveBuild(code === 0
      ? { ok: true, workingDir: REPO_ROOT }
      : { ok: false, output: `exited with status ${code}: ${Buffer.concat(chunks).toString('utf8')}` });
  });
});

/** Every story file in the components' folders. */
function storyFiles(components: readonly LibraryComponent[]): readonly string[] {
  return components.flatMap((component) => component.files.filter((file) => STORY_FILE.test(posix.basename(file))));
}

/** A `_library` finding with no place. */
function libraryFinding(finding: GateFinding): StoryHealthFinding {
  return { component: LIBRARY_COMPONENT, finding };
}

/** The `importPath` of each story id in the build's `index.json`. */
function readImportPaths(staticDir: string): ReadonlyMap<string, string> {
  const index = storybookIndexSchema.parse(JSON.parse(readFileSync(join(staticDir, 'index.json'), 'utf8')));

  return new Map(Object.values(index.entries)
    .filter((entry) => entry.type === 'story')
    .map((entry) => [entry.id, entry.importPath]));
}

/** What the rendered check found, and how many checked stories came from `target.dir`. */
interface RenderedReading {
  readonly findings: readonly StoryHealthFinding[];
  readonly libraryStories: number;
}

/** The findings of the rendered check's `checks`, mapped to components through `importPaths`. */
function mapChecks(
  checks: readonly StoryCheck[],
  importPaths: ReadonlyMap<string, string>,
  workingDir: string,
  targetDir: string,
  components: readonly LibraryComponent[],
): RenderedReading {
  const placed = checks.map((check) => {
    const importPath = importPaths.get(check.id);
    const file = importPath === undefined
      ? null
      : targetRelative(targetDir, resolve(workingDir, importPath));

    return { check, importPath, file };
  });
  const findings = placed
    .filter(({ check }) => check.errors.length > 0)
    .map(({ check, importPath, file }) => {
      const where = file ?? (importPath === undefined
        ? 'a file the build\'s index.json does not name'
        : `${importPath}, outside the library`);
      const message = `story ${check.id} (${where}) errs when rendered in the built Storybook: ${check.errors.join('; ')}`;

      return {
        component: owningComponent(file, components),
        finding: { rule: STORY_RENDERS_CLEAN_RULE, file, line: null, message },
      };
    });

  return { findings, libraryStories: placed.filter(({ file }) => file !== null).length };
}

/** The `_library` finding for a build that exited non-zero, carrying the end of its output. */
function buildFailedFinding(output: string): StoryHealthFinding {
  const tail = output.trim().slice(-MAX_BUILD_OUTPUT);

  return libraryFinding({
    rule: STORYBOOK_BUILD_RULE,
    file: null,
    line: null,
    message: `storybook build ${tail || 'failed with no output'}`,
  });
}

/**
 * Builds the Storybook into a temp folder, renders its stories and maps
 * their errors to components. The temp folder is removed before it returns
 * or throws.
 */
async function renderedFindings(
  options: StoryHealthGateOptions,
  components: readonly LibraryComponent[],
): Promise<readonly StoryHealthFinding[]> {
  const outputDir = mkdtempSync(join(tmpdir(), 'd2c-story-health-'));

  try {
    const build = await (options.build ?? buildStorybook)({ project: options.project, outputDir });

    if (!build.ok) {
      return [buildFailedFinding(build.output)];
    }

    const checks = await (options.check ?? checkStories)(outputDir, options.port ?? DEFAULT_CHECK_PORT);
    const reading = mapChecks(checks, readImportPaths(outputDir), build.workingDir, options.targetDir, components);
    const scannedNone = reading.libraryStories === 0
      ? [libraryFinding(scannedZeroFilesFinding(`the built Storybook, which rendered no story from ${LIBRARY_SOURCE_DIR}`))]
      : [];

    return [...reading.findings, ...scannedNone];
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

/** Every finding over the library: the static checks', then the rendered check's. */
async function check(options: StoryHealthGateOptions, components: readonly LibraryComponent[]): Promise<readonly StoryHealthFinding[]> {
  const staticFindings = runStaticChecks({ targetDir: options.targetDir, components, previewPath: options.previewPath });
  const rendered = await renderedFindings(options, components);

  return [...staticFindings, ...rendered];
}

/**
 * Runs the static checks over the library at `targetDir`, read through
 * `levels`, builds the Storybook for `project` and renders its stories, and
 * writes one `story-health.json` per listed component, plus one for
 * `_library` when it holds a finding.
 *
 * @throws when a level is not a single folder name, when a story file or
 *   the preview exists but cannot be read, when the build cannot be
 *   started, when the checker throws, when the build's `index.json` is
 *   missing or malformed, or when a result cannot be written.
 */
export async function runStoryHealthGate(options: StoryHealthGateOptions): Promise<StoryHealthGateRun> {
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const library = listLibrary(options.targetDir, options.levels);
  const scannedFiles = storyFiles(library.components).length;
  const found = scannedFiles === 0
    ? [libraryFinding(scannedZeroFilesFinding(`the story files of ${LIBRARY_SOURCE_DIR}`))]
    : await check(options, library.components);
  const grouped = groupFindings(found.map(({ component, finding }) => [component, finding] as const));
  const durationMs = Math.max(0, now() - startedAt);
  const listed = [...new Set(library.components.map((component) => component.name))].filter((name) => name !== LIBRARY_COMPONENT);
  const components = grouped.has(LIBRARY_COMPONENT)
    ? [...listed, LIBRARY_COMPONENT]
    : listed;
  const results = components.map((component) => toResult(STORY_HEALTH_GATE, component, grouped.get(component) ?? [], durationMs));

  if (!grouped.has(LIBRARY_COMPONENT)) {
    rmSync(gateResultPath(options.targetDir, LIBRARY_COMPONENT, STORY_HEALTH_GATE), { force: true });
  }

  const paths = results.map((result) => writeGateResult(options.targetDir, result));
  const status = results.some((result) => result.status === 'fail')
    ? 'fail'
    : 'pass';

  return { status, results, paths, scannedFiles };
}
