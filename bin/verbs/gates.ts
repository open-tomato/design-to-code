/**
 * The `gates` verb: `d2c gates --local`.
 *
 * It loads the active project's config and runs the local gates over its
 * library at `target.dir`, in {@link GATE_NAMES} order: `structure`,
 * `state-coverage`, `build-lint`, `story-health`. Every gate runs even when
 * an earlier one fails, and each writes its own results under
 * `<target.dir>/gate-results/`. The verb prints one summary line per gate
 * on stdout and exits 0 only when every gate passed, else 1.
 *
 * `--local` is required for now: the CI gates are not implemented yet, so
 * without it the verb is a usage error naming `--local`. A config
 * failure, or a `target.dir` that does not exist or is not a folder, is a
 * refusal, printed as `d2c gates: <message>` on stderr with exit 1, and no
 * gate runs. Before the first gate runs, the verb removes the
 * `gate-results/<component>/` folder of every component the library no
 * longer holds (see {@link removeStaleResults}). A seed manifest that is missing or not valid refuses only the
 * gate that reads it: its `d2c gates: <message>` goes on stderr, every other
 * gate still runs and prints its summary line, and the verb exits 1. An
 * empty `target.dir` is no refusal: every gate runs and fails with a
 * `scanned-zero-files` finding.
 *
 * The gate runners are injectable (see {@link GateRunners}), so the verb's
 * logic runs without a browser, a build or a library on disk.
 *
 * @packageDocumentation
 */

import type { CliResult } from './result.ts';
import type { LoadOptions } from '../../config/load.ts';
import type { GateName, GateResult } from '../../pipeline/gates/result.ts';

import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { loadProjectConfig, ProjectConfigError, REPO_ROOT } from '../../config/load.ts';
import { runBuildLintGate } from '../../pipeline/gates/build-lint/index.ts';
import { listLibrary } from '../../pipeline/gates/library.ts';
import { GATE_NAMES } from '../../pipeline/gates/result.ts';
import { removeStaleResults } from '../../pipeline/gates/stale-results.ts';
import { runStateCoverageGate } from '../../pipeline/gates/state-coverage/index.ts';
import { runStoryHealthGate } from '../../pipeline/gates/story-health/index.ts';
import { runStructureGate } from '../../pipeline/gates/structure/index.ts';
import { SeedFileError } from '../../pipeline/seed/files.ts';

import { isParseArgsError, verbFailure } from './result.ts';

/** The verb's name, as typed on the command line and printed in output. */
const VERB = 'gates';

/** The usage error's message when `--local` is left out. */
export const LOCAL_REQUIRED_MESSAGE = '--local is required: only the local gates run so far';

/** The options the `gates` verb accepts, in `node:util` `parseArgs` form. */
const GATES_OPTIONS = {
  local: { type: 'boolean', default: false },
} as const;

/** The flags of one `gates` invocation. */
export interface GatesArguments {
  /** Run the local gates; the only mode so far, so always `true`. */
  readonly local: true;
}

/** What every gate runner is given: the active project's paths and levels. */
export interface GateContext {
  /** The project slug, `D2C_PROJECT`. */
  readonly project: string;
  /** The design export's root, `source.dir`, absolute. */
  readonly sourceDir: string;
  /** The library's root, `target.dir`, absolute; results are written under it. */
  readonly targetDir: string;
  /** The level folder names, lowest first: the config's `levels`. */
  readonly levels: readonly string[];
}

/** What one gate run hands back to the verb. */
export interface GateOutcome {
  /** `fail` when any result failed, `pass` otherwise. */
  readonly status: 'pass' | 'fail';
  /** Every result the gate wrote. */
  readonly results: readonly GateResult[];
  /** The number of files the gate scanned. */
  readonly scannedFiles: number;
}

/** Runs one gate over the active project's library and writes its results. */
export type GateRunner = (context: GateContext) => GateOutcome | Promise<GateOutcome>;

/** One runner per gate name. */
export type GateRunners = Readonly<Record<GateName, GateRunner>>;

/** The local gates, each the gate module's own run function. */
export const LOCAL_GATE_RUNNERS: GateRunners = {
  'structure': ({ targetDir, levels }) => runStructureGate({ targetDir, levels }),
  'state-coverage': ({ sourceDir, targetDir, levels }) => runStateCoverageGate({ sourceDir, targetDir, levels }),
  'build-lint': ({ targetDir, levels }) => runBuildLintGate({ targetDir, levels }),
  'story-health': ({ project, targetDir, levels }) => runStoryHealthGate({ project, targetDir, levels }),
};

/**
 * Parses the `gates` verb's arguments.
 *
 * @param args - The arguments after `gates`.
 * @returns The flags, or the usage error's message as a string: an option
 *   the verb does not know, or {@link LOCAL_REQUIRED_MESSAGE} when
 *   `--local` is left out.
 */
export function parseGatesArguments(args: readonly string[]): GatesArguments | string {
  try {
    const { values } = parseArgs({ args: [...args], options: GATES_OPTIONS, strict: true, allowPositionals: false });

    return values.local
      ? { local: true }
      : LOCAL_REQUIRED_MESSAGE;
  } catch (error) {
    if (isParseArgsError(error)) {
      return error.message;
    }

    throw error;
  }
}

/** A refusal the verb prints: the target library is missing or not a folder. */
class MissingTargetError extends Error {
  override readonly name = 'MissingTargetError';
}

/** Whether `error` is one the verb prints rather than propagates. */
function isReportedError(error: unknown): error is Error {
  return error instanceof ProjectConfigError
    || error instanceof MissingTargetError;
}

/** Throws a {@link MissingTargetError} unless `targetDir` is a folder. */
function checkTargetDir(targetDir: string, displayDir: string): void {
  const stats = statSync(targetDir, { throwIfNoEntry: false });

  if (stats === undefined) {
    throw new MissingTargetError(`target.dir: '${displayDir}' does not exist (${targetDir})`);
  }

  if (!stats.isDirectory()) {
    throw new MissingTargetError(`target.dir: '${displayDir}' is not a directory (${targetDir})`);
  }
}

/** `count` and `noun`, the noun plural unless the count is 1: `1 result`, `2 results`. */
function counted(count: number, noun: string): string {
  return count === 1
    ? `${count} ${noun}`
    : `${count} ${noun}s`;
}

/** One gate's summary line: its verdict, how many results failed, its findings and files scanned. */
function summarizeGate(gate: GateName, outcome: GateOutcome): string {
  const failed = outcome.results.filter((result) => result.status === 'fail').length;
  const findings = outcome.results.reduce((total, result) => total + result.findings.length, 0);
  const counts = outcome.status === 'fail'
    ? `${failed} of ${counted(outcome.results.length, 'result')} failed, ${counted(findings, 'finding')}`
    : counted(outcome.results.length, 'result');

  return `d2c ${VERB}: ${gate} ${outcome.status} (${counts}, ${counted(outcome.scannedFiles, 'file')} scanned)\n`;
}

/** How one gate's run went: its outcome, or the refusal it threw. */
type GateRun =
  | { readonly gate: GateName; readonly outcome: GateOutcome }
  | { readonly gate: GateName; readonly refusal: string };

/** One gate's run with the gate's {@link SeedFileError} caught as a refusal; any other error propagates. */
async function runOneGate(gate: GateName, context: GateContext, runner: GateRunner): Promise<GateRun> {
  try {
    return { gate, outcome: await runner(context) };
  } catch (error) {
    if (error instanceof SeedFileError) {
      return { gate, refusal: error.message };
    }

    throw error;
  }
}

/**
 * Runs every gate in {@link GATE_NAMES} order, each once the last has
 * finished, whatever its verdict or refusal: `build-lint` and
 * `story-health` each spawn heavy tools, so they never overlap.
 */
function runEveryGate(context: GateContext, runners: GateRunners): Promise<readonly GateRun[]> {
  return GATE_NAMES.reduce<Promise<readonly GateRun[]>>(
    async (earlier, gate) => [...await earlier, await runOneGate(gate, context, runners[gate])],
    Promise.resolve([]),
  );
}

/** One gate's name and the outcome it reached. */
type NamedOutcome = readonly [GateName, GateOutcome];

/**
 * The verb's result from every gate's run: a summary line per gate that
 * reached an outcome on stdout; on stderr a `d2c gates: <message>` line per
 * refused gate, then the failed gates out of those that reached an outcome.
 */
function gatesResult(runs: readonly GateRun[]): CliResult {
  const outcomes = runs.flatMap((run): NamedOutcome[] => 'outcome' in run
    ? [[run.gate, run.outcome]]
    : []);
  const refusals = runs.flatMap((run) => 'refusal' in run
    ? [`d2c ${VERB}: ${run.refusal}\n`]
    : []);
  const failed = outcomes.filter(([, outcome]) => outcome.status === 'fail').map(([gate]) => gate);
  const failedLine = failed.length === 0
    ? ''
    : `d2c ${VERB}: ${failed.length} of ${outcomes.length} gates failed: ${failed.join(', ')}\n`;
  const stdout = outcomes.map(([gate, outcome]) => summarizeGate(gate, outcome)).join('');
  const stderr = refusals.join('') + failedLine;
  const exitCode = stderr === ''
    ? 0
    : 1;

  return { exitCode, stdout, stderr };
}

/**
 * The `gates` verb: runs the local gates over the active project's library.
 *
 * The config is loaded with `source.dir` required to exist, and
 * `target.dir` must be a folder; a {@link ProjectConfigError} or a missing
 * or non-folder `target.dir` is a refusal and runs no gate. A
 * {@link SeedFileError} a gate throws (a seed manifest that is missing, is
 * not JSON or fails its schema) refuses that gate only: the run goes on to
 * the next gate. Any other error a gate throws propagates and stops the run.
 * Once `target.dir` is checked and before the first gate runs, the
 * results left by components the library no longer holds are removed.
 *
 * @param flags - The parsed flags.
 * @param options - The environment and root the loader reads from.
 * @param runners - The gate runners; {@link LOCAL_GATE_RUNNERS} when left out.
 * @returns One summary line per gate that reached an outcome on stdout,
 *   with exit 0 when every gate passed; exit 1 when any gate failed or was
 *   refused, with each refused gate's `d2c gates: <message>` and then the
 *   failed gates named on stderr; or, for a config or `target.dir` refusal,
 *   only `d2c gates: <message>` on stderr with exit 1.
 */
export async function runGates(
  flags: GatesArguments,
  options: LoadOptions,
  runners: GateRunners = LOCAL_GATE_RUNNERS,
): Promise<CliResult> {
  try {
    const rootDir = options.rootDir ?? REPO_ROOT;
    const config = loadProjectConfig(options);
    const targetDir = resolve(rootDir, config.target.dir);

    checkTargetDir(targetDir, config.target.dir);

    const context: GateContext = {
      project: config.slug,
      sourceDir: resolve(rootDir, config.source.dir),
      targetDir,
      levels: config.levels,
    };
    const componentNames = listLibrary(targetDir, config.levels).components.map((component) => component.name);

    removeStaleResults(targetDir, componentNames);

    return gatesResult(await runEveryGate(context, runners));
  } catch (error) {
    if (isReportedError(error)) {
      return verbFailure(VERB, error.message);
    }

    throw error;
  }
}
