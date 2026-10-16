/**
 * The build and lint gate: type-checks a library with `tsc` and lints it
 * with ESLint through the library's own config, and writes what they found
 * as `build-lint` gate results.
 *
 * `tsc --noEmit --pretty false -p <target.dir>` runs in `target.dir`, with
 * the tool's own TypeScript (`@typescript/native`, the `tsc` that
 * `bun run check-types` runs), under the running JavaScript runtime. Each
 * diagnostic it prints is one finding whose rule is {@link TSC_RULE} and
 * whose message starts with the diagnostic's code, such as `TS2322: …`.
 * When `tsc` exits non-zero and prints no diagnostic this module can read,
 * its output becomes one `tsc` finding under `_library`, so a broken
 * `tsconfig.json` never reads as a pass.
 *
 * ESLint runs through its Node API over `src`, with `target.dir` as its
 * working folder and the library's config: `<target.dir>/eslint.config.mjs`
 * when the library has one, the template every extraction copies
 * ({@link TEMPLATE_ESLINT_CONFIG}) otherwise, never the root config, which
 * ignores `components/**`. Each message of severity `error` is one finding
 * whose rule is the message's rule id, such as `d2c/cva-only-classname`; a
 * fatal message with no rule id, such as a parse error, reads
 * {@link ESLINT_FATAL_RULE}. Lint findings come by file path. Warnings are
 * not findings, since a finding fails its result.
 *
 * Each finding goes to the component whose folder holds its file, among
 * those `listLibrary` lists under `<target.dir>/src/<level>/`, with its
 * file POSIX-relative to `target.dir` and its 1-based line. A finding whose
 * file is in no component folder, such as `src/lib/cn.ts`, goes to
 * `_library`; one whose file is outside `target.dir` keeps no file or line,
 * and its message names the path instead.
 *
 * Every listed component gets one `build-lint.json` under
 * `<target.dir>/gate-results/<component>/`: a `fail` carrying its findings
 * when it has any, a `pass` otherwise. Two components sharing a name in
 * different levels share one result file, their findings merged.
 * `_library` gets one only when it holds a finding; a `_library` result
 * left by an earlier run is removed when this run finds nothing there.
 *
 * When the library's component folders hold zero files, the gate runs
 * neither tool and fails with a `scanned-zero-files` finding under
 * `_library`, so an empty or misplaced library never reads as a pass.
 * Every result carries the whole run's duration as its `durationMs`.
 *
 * @packageDocumentation
 */

import type { LibraryComponent } from '../library.ts';
import type { GateFinding, GateResult } from '../result.ts';

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import { ESLint } from 'eslint';

import { groupFindings, targetRelative, toResult } from '../findings.ts';
import { listLibrary, LIBRARY_SOURCE_DIR } from '../library.ts';
import { gateResultPath, LIBRARY_COMPONENT, scannedZeroFilesFinding, writeGateResult } from '../result.ts';

/** The gate name, as written in results and result file names. */
export const BUILD_LINT_GATE = 'build-lint';

/** The rule of every finding `tsc` reports. */
export const TSC_RULE = 'tsc';

/** The rule of an ESLint error that names no rule, such as a parse error. */
export const ESLINT_FATAL_RULE = 'eslint-fatal';

/** The file name of a library's own ESLint config, directly in `target.dir`. */
export const LIBRARY_ESLINT_CONFIG_FILE = 'eslint.config.mjs';

/** The library ESLint config every extraction copies, used when a library has none of its own. */
export const TEMPLATE_ESLINT_CONFIG = resolve(import.meta.dirname, '..', '..', '..', 'templates', 'library', LIBRARY_ESLINT_CONFIG_FILE);

/** ESLint's numeric severity for `error`. */
const ESLINT_ERROR = 2;

/** The most characters of unreadable `tsc` output a finding's message carries. */
const MAX_RAW_OUTPUT = 2000;

/** A `tsc --pretty false` diagnostic placed in a file: `file(line,col): error TS1234: message`. */
const PLACED_DIAGNOSTIC = /^(.+)\((\d+),(\d+)\): (error|warning|message) (TS\d+): (.*)$/;

/** A `tsc --pretty false` diagnostic with no file: `error TS1234: message`. */
const GLOBAL_DIAGNOSTIC = /^(error|warning|message) (TS\d+): (.*)$/;

/** What the build and lint gate reads. */
export interface BuildLintGateOptions {
  /** The library's root, the config's `target.dir`; results are written under it. */
  readonly targetDir: string;
  /** The level folder names, lowest first: the config's `levels`. */
  readonly levels: readonly string[];
  /** The ESLint config to lint with; {@link libraryEslintConfig} of `targetDir` when left out. */
  readonly eslintConfigFile?: string;
  /** The clock, in milliseconds, used for `durationMs`; `performance.now` when left out. */
  readonly now?: () => number;
}

/** What one run of the build and lint gate wrote. */
export interface BuildLintGateRun {
  /** `fail` when any result failed, `pass` otherwise. */
  readonly status: 'pass' | 'fail';
  /** Every result written, listed components first in library order, then `_library`. */
  readonly results: readonly GateResult[];
  /** The absolute path of each result, in the order of `results`. */
  readonly paths: readonly string[];
  /** The number of files in the library's component folders. */
  readonly scannedFiles: number;
}

/** One diagnostic `tsc` printed, its file as printed (relative to where `tsc` ran) or `null`. */
export interface TscDiagnostic {
  /** The file, as `tsc` printed it; `null` for a diagnostic placed in no file. */
  readonly file: string | null;
  /** The 1-based line; `null` for a diagnostic placed in no file. */
  readonly line: number | null;
  /** The code and text, such as `TS2322: Type 'string' is not assignable …`. */
  readonly message: string;
}

/** A finding with the file it was reported against, before it is placed in a component. */
interface ToolFinding {
  /** The rule the finding is written under. */
  readonly rule: string;
  /** The file as the tool reported it, absolute or relative to `targetDir`; `null` for none. */
  readonly file: string | null;
  /** The 1-based line the tool reported; `null` for none. */
  readonly line: number | null;
  /** The tool's message. */
  readonly message: string;
}

/**
 * The diagnostics in `output`, the stdout of `tsc --pretty false`, in
 * order. A line indented under a diagnostic continues its message, joined
 * with a space; any other line is skipped.
 */
export function parseTscOutput(output: string): readonly TscDiagnostic[] {
  return output.split(/\r?\n/).reduce<readonly TscDiagnostic[]>((diagnostics, text) => {
    const placed = PLACED_DIAGNOSTIC.exec(text);

    if (placed !== null) {
      return [...diagnostics, { file: placed[1] ?? null, line: Number(placed[2]), message: `${placed[5]}: ${placed[6]}` }];
    }

    const global = GLOBAL_DIAGNOSTIC.exec(text);

    if (global !== null) {
      return [...diagnostics, { file: null, line: null, message: `${global[2]}: ${global[3]}` }];
    }

    const last = diagnostics.at(-1);

    if (last !== undefined && /^\s+\S/.test(text)) {
      return [...diagnostics.slice(0, -1), { ...last, message: `${last.message} ${text.trim()}` }];
    }

    return diagnostics;
  }, []);
}

/**
 * The ESLint config the gate lints `targetDir` with: the library's own
 * `eslint.config.mjs` when it has one, {@link TEMPLATE_ESLINT_CONFIG}
 * otherwise.
 */
export function libraryEslintConfig(targetDir: string): string {
  const own = join(targetDir, LIBRARY_ESLINT_CONFIG_FILE);

  return existsSync(own)
    ? own
    : TEMPLATE_ESLINT_CONFIG;
}

/** The path of the tool's `tsc` script, from `@typescript/native`. */
function tscScript(): string {
  const manifest = createRequire(import.meta.url).resolve('@typescript/native/package.json');

  return join(dirname(manifest), 'bin', 'tsc');
}

/**
 * The findings of `tsc --noEmit -p <targetDir>`, run in `targetDir`.
 *
 * @throws when `tsc` cannot be started or is killed by a signal.
 */
function typeCheck(targetDir: string): readonly ToolFinding[] {
  const child = spawnSync(process.execPath, [tscScript(), '--noEmit', '--pretty', 'false', '-p', targetDir], {
    cwd: targetDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  if (child.error !== undefined) {
    throw child.error;
  }

  if (child.status === null) {
    throw new Error(`tsc was killed by ${child.signal ?? 'a signal'}`);
  }

  const diagnostics = parseTscOutput(child.stdout);

  if (child.status !== 0 && diagnostics.length === 0) {
    const output = `${child.stdout}${child.stderr}`.trim().slice(0, MAX_RAW_OUTPUT);

    return [{ rule: TSC_RULE, file: null, line: null, message: `tsc exited with status ${child.status}: ${output || 'no output'}` }];
  }

  return diagnostics.map((diagnostic) => ({ rule: TSC_RULE, ...diagnostic }));
}

/** Compares two strings by code unit, so the order is the same on every machine. */
function byCodeUnit(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  return left < right
    ? -1
    : 1;
}

/**
 * The findings of ESLint over `<targetDir>/src` through `configFile`:
 * errors only, by file path, then in the order ESLint reports them within
 * a file.
 */
async function lint(targetDir: string, configFile: string): Promise<readonly ToolFinding[]> {
  const eslint = new ESLint({ cwd: targetDir, overrideConfigFile: configFile, errorOnUnmatchedPattern: false });
  const results = await eslint.lintFiles([LIBRARY_SOURCE_DIR]);

  return [...results].sort((left, right) => byCodeUnit(left.filePath, right.filePath)).flatMap((result) => result.messages
    .filter((message) => message.severity === ESLINT_ERROR)
    .map((message) => ({
      rule: message.ruleId ?? ESLINT_FATAL_RULE,
      file: result.filePath,
      line: message.line,
      message: message.message,
    })));
}

/**
 * The component whose folder holds `file` (POSIX-relative to
 * `target.dir`), or `_library` when no listed component's does.
 */
export function owningComponent(file: string | null, components: readonly LibraryComponent[]): string {
  const owner = file === null
    ? undefined
    : components.find((component) => file.startsWith(`${component.dir}/`));

  return owner?.name ?? LIBRARY_COMPONENT;
}

/** `found` as gate findings, each with the component it goes to. */
function placeFindings(
  targetDir: string,
  found: readonly ToolFinding[],
  components: readonly LibraryComponent[],
): readonly (readonly [string, GateFinding])[] {
  return found.map((finding) => {
    const file = finding.file === null
      ? null
      : targetRelative(targetDir, finding.file);
    const line = file !== null && finding.line !== null && Number.isInteger(finding.line) && finding.line >= 1
      ? finding.line
      : null;
    const message = finding.file !== null && file === null
      ? `${finding.file}: ${finding.message}`
      : finding.message;

    return [owningComponent(file, components), { rule: finding.rule, file, line, message }] as const;
  });
}

/** Every tool finding over the library at `targetDir`, `tsc`'s first. */
async function check(targetDir: string, configFile: string): Promise<readonly ToolFinding[]> {
  const typeErrors = typeCheck(targetDir);
  const lintErrors = await lint(targetDir, configFile);

  return [...typeErrors, ...lintErrors];
}

/**
 * Type-checks and lints the library at `targetDir`, read through `levels`,
 * and writes one `build-lint.json` per listed component, plus one for
 * `_library` when it holds a finding.
 *
 * @throws when a level is not a single folder name, when `tsc` cannot be
 *   started, when ESLint cannot load its config or crashes on a file, or
 *   when a result cannot be written.
 */
export async function runBuildLintGate(options: BuildLintGateOptions): Promise<BuildLintGateRun> {
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const library = listLibrary(options.targetDir, options.levels);
  const found = library.scannedFiles === 0
    ? [[LIBRARY_COMPONENT, scannedZeroFilesFinding(LIBRARY_SOURCE_DIR)] as const]
    : placeFindings(
      options.targetDir,
      await check(options.targetDir, options.eslintConfigFile ?? libraryEslintConfig(options.targetDir)),
      library.components,
    );
  const grouped = groupFindings(found);
  const durationMs = Math.max(0, now() - startedAt);
  const listed = [...new Set(library.components.map((component) => component.name))].filter((name) => name !== LIBRARY_COMPONENT);
  const components = grouped.has(LIBRARY_COMPONENT)
    ? [...listed, LIBRARY_COMPONENT]
    : listed;
  const results = components.map((component) => toResult(BUILD_LINT_GATE, component, grouped.get(component) ?? [], durationMs));

  if (!grouped.has(LIBRARY_COMPONENT)) {
    rmSync(gateResultPath(options.targetDir, LIBRARY_COMPONENT, BUILD_LINT_GATE), { force: true });
  }

  const paths = results.map((result) => writeGateResult(options.targetDir, result));
  const status = results.some((result) => result.status === 'fail')
    ? 'fail'
    : 'pass';

  return { status, results, paths, scannedFiles: library.scannedFiles };
}
