/**
 * The `assess` verb: `d2c assess [--scripts-only]`.
 *
 * It runs the discovery scripts over the active project's `source.dir` and
 * writes their report to `<source.dir>/discovery.json`. Unless
 * `--scripts-only` is given it then runs the assess agent over that report
 * with the injected {@link AgentSpawner} (`claude -p` from the CLI) and
 * writes the report again with the agent's notes merged in. The scripts'
 * report is written first, so an agent that fails or is refused leaves
 * `discovery.json` as the scripts wrote it.
 *
 * @packageDocumentation
 */

import type { CliResult } from './result.ts';
import type { LoadOptions } from '../../config/load.ts';
import type { AgentSpawner } from '../../pipeline/assess/agent.ts';
import type { DiscoveryReport } from '../../pipeline/assess/schema.ts';

import { relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { loadProjectConfig, ProjectConfigError, REPO_ROOT } from '../../config/load.ts';
import { AgentOutputError, runAssessAgent } from '../../pipeline/assess/agent.ts';
import { discover, discoveryPath, writeDiscovery } from '../../pipeline/assess/discover.ts';
import { AssessRefusedError } from '../../pipeline/assess/errors.ts';
import { MergeRefusedError } from '../../pipeline/assess/merge.ts';

import { isParseArgsError, verbFailure } from './result.ts';
import { AgentSpawnError } from './spawner.ts';

/** The verb's name, as typed on the command line and printed in output. */
const VERB = 'assess';

/** The options the `assess` verb accepts, in `node:util` `parseArgs` form. */
const ASSESS_OPTIONS = {
  'scripts-only': { type: 'boolean', default: false },
} as const;

/** The flags of one `assess` invocation. */
export interface AssessArguments {
  /** Write the scripts' report and skip the agent. */
  readonly scriptsOnly: boolean;
}

/**
 * Parses the `assess` verb's arguments.
 *
 * @param args - The arguments after `assess`.
 * @returns The flags, or the usage error's message as a string.
 */
export function parseAssessArguments(args: readonly string[]): AssessArguments | string {
  try {
    const { values } = parseArgs({ args: [...args], options: ASSESS_OPTIONS, strict: true, allowPositionals: false });

    return { scriptsOnly: values['scripts-only'] };
  } catch (error) {
    if (isParseArgsError(error)) {
      return error.message;
    }

    throw error;
  }
}

/** Whether `error` is one the verb prints rather than propagates. */
function isReportedError(error: unknown): error is Error {
  return error instanceof ProjectConfigError
    || error instanceof AssessRefusedError
    || error instanceof AgentSpawnError
    || error instanceof AgentOutputError
    || error instanceof MergeRefusedError;
}

/** The one-line summary printed after the final write. */
function summarize(report: DiscoveryReport, written: string, scriptsOnly: boolean): string {
  const how = scriptsOnly
    ? 'scripts only'
    : 'agent notes merged';

  return `d2c ${VERB}: ${report.pages.length} pages, ${report.tokens.length} token files, `
    + `${report.variantMaps.length} variant maps; wrote ${written} (${how})\n`;
}

/**
 * The `assess` verb: discovers the active project's `source.dir`, writes
 * `discovery.json`, and, without `--scripts-only`, merges the agent's
 * notes into it.
 *
 * The config is loaded with `source.dir` required to exist. Only a
 * {@link ProjectConfigError}, an {@link AssessRefusedError} (a symlink or
 * other non-regular entry in the export, or a sampled page that is not a
 * regular file inside the source dir), an {@link AgentSpawnError}, an
 * {@link AgentOutputError} or a {@link MergeRefusedError} is turned into
 * output; any other error, a system error such as `ENOENT` among them,
 * propagates.
 *
 * @param flags - The parsed flags.
 * @param options - The environment and root the loader reads from.
 * @param spawn - Runs the agent; not called with `--scripts-only`.
 * @returns A summary on stdout with exit 0, or the failure as
 *   `d2c assess: <message>` on stderr with exit 1.
 */
export async function runAssess(
  flags: AssessArguments,
  options: LoadOptions,
  spawn: AgentSpawner,
): Promise<CliResult> {
  try {
    const rootDir = options.rootDir ?? REPO_ROOT;
    const config = loadProjectConfig(options);
    const sourceDir = resolve(rootDir, config.source.dir);
    const written = relative(rootDir, discoveryPath(sourceDir));
    const scripted = writeDiscovery(sourceDir, discover(sourceDir));

    if (flags.scriptsOnly) {
      return { exitCode: 0, stdout: summarize(scripted, written, true), stderr: '' };
    }

    const merged = writeDiscovery(sourceDir, await runAssessAgent(sourceDir, scripted, spawn));

    return { exitCode: 0, stdout: summarize(merged, written, false), stderr: '' };
  } catch (error) {
    if (isReportedError(error)) {
      return verbFailure(VERB, error.message);
    }

    throw error;
  }
}
