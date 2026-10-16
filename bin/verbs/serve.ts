/**
 * The `serve` verb: `d2c serve [--check]`.
 *
 * Without `--check` it starts the static server (`pipeline/serve/server.ts`)
 * over the active project's `source.dir`, with curation writing to
 * `projects/<slug>.json`, prints the address it serves on and resolves with
 * a {@link CliResult.stop} handle: the server outlives the call, and the
 * caller stops it (the CLI entry point does so on SIGINT or SIGTERM).
 *
 * With `--check` it starts its own server under the same port rules, loads
 * every kept page headless (`pipeline/serve/check.ts`), which writes
 * `<source.dir>/serve-check.json`, stops the server, and exits 0 only when
 * no page has a console error, a failed request or a blank render. The
 * report is written either way.
 *
 * Both refuse to start without `<source.dir>/discovery.json`, naming the
 * command that writes it.
 *
 * @packageDocumentation
 */

import type { CliResult } from './result.ts';
import type { LoadOptions } from '../../config/load.ts';
import type { CheckPagesOptions, ServeCheckReport } from '../../pipeline/serve/check.ts';
import type { RunningServer } from '../../pipeline/serve/server.ts';

import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { loadProjectConfig, ProjectConfigError, REPO_ROOT } from '../../config/load.ts';
import { savePageChoice } from '../../config/save.ts';
import { discoveryPath } from '../../pipeline/assess/discover.ts';
import { isCleanReport, serveCheckPath } from '../../pipeline/serve/check.ts';
import { ServePortError } from '../../pipeline/serve/port.ts';
import { startServer } from '../../pipeline/serve/server.ts';

import { isParseArgsError, verbFailure } from './result.ts';

/** The verb's name, as typed on the command line and printed in output. */
const VERB = 'serve';

/** The command that writes the `discovery.json` the verb needs. */
export const DISCOVERY_COMMAND = 'bun run d2c assess --scripts-only';

/** The options the `serve` verb accepts, in `node:util` `parseArgs` form. */
const SERVE_OPTIONS = {
  check: { type: 'boolean', default: false },
} as const;

/** The flags of one `serve` invocation. */
export interface ServeArguments {
  /** Run the headless health check once instead of serving until stopped. */
  readonly check: boolean;
}

/** Runs the health check; `checkPages` from `pipeline/serve/check.ts` in the CLI. */
export type PageChecker = (options: CheckPagesOptions) => Promise<ServeCheckReport>;

/** What the `serve` verb reads from and how it checks pages. */
export interface ServeOptions extends LoadOptions {
  /** Runs the health check for `--check`. */
  readonly checkPages: PageChecker;
  /**
   * A seam for tests, with no CLI flag: the port the server binds, passed
   * to `startServer` as its `port`, so it outranks `D2C_PORT` and never
   * falls back. `0` has the operating system assign a free port. Unset,
   * `D2C_PORT` and then the 4600 range apply.
   */
  readonly port?: number;
}

/**
 * Parses the `serve` verb's arguments.
 *
 * @param args - The arguments after `serve`.
 * @returns The flags, or the usage error's message as a string.
 */
export function parseServeArguments(args: readonly string[]): ServeArguments | string {
  try {
    const { values } = parseArgs({ args: [...args], options: SERVE_OPTIONS, strict: true, allowPositionals: false });

    return { check: values.check };
  } catch (error) {
    if (isParseArgsError(error)) {
      return error.message;
    }

    throw error;
  }
}

/** `source.dir` has no `discovery.json` for the server to list pages from. */
export class MissingDiscoveryError extends Error {
  override readonly name = 'MissingDiscoveryError';
}

/** Whether `error` is one the verb prints rather than propagates. */
function isReportedError(error: unknown): error is Error {
  return error instanceof ProjectConfigError
    || error instanceof MissingDiscoveryError
    || error instanceof ServePortError;
}

/** Throws a {@link MissingDiscoveryError} unless `<sourceDir>/discovery.json` exists. */
function assertDiscovery(sourceDir: string, displayDir: string): void {
  if (!existsSync(discoveryPath(sourceDir))) {
    throw new MissingDiscoveryError(
      `${displayDir}/discovery.json not found; run '${DISCOVERY_COMMAND}' first`,
    );
  }
}

/** The pages of `report` with a console error, a failed request or a blank render. */
function problemPages(report: ServeCheckReport): readonly string[] {
  return report.pages
    .filter((page) => page.consoleErrors.length > 0 || page.failedRequests.length > 0 || page.blank)
    .map((page) => page.path);
}

/**
 * Checks every kept page against `server`, stopping the server whether or
 * not the check succeeds.
 */
async function checkAndStop(
  server: RunningServer,
  checkPages: PageChecker,
  options: CheckPagesOptions,
): Promise<ServeCheckReport> {
  try {
    return await checkPages(options);
  } finally {
    await server.stop();
  }
}

/**
 * Turns a written health-check report into the verb's output; `written`
 * is the report's path under `source.dir` as the config gives it.
 */
function checkResult(report: ServeCheckReport, written: string): CliResult {
  const summary = `d2c ${VERB}: checked ${report.pages.length} pages at ${report.address}; wrote ${written}\n`;

  if (isCleanReport(report)) {
    return { exitCode: 0, stdout: summary, stderr: '' };
  }

  const problems = problemPages(report);

  return {
    exitCode: 1,
    stdout: summary,
    stderr: `d2c ${VERB}: ${problems.length} pages have problems: ${problems.join(', ')}\n`,
  };
}

/**
 * The `serve` verb: serves the active project's `source.dir`, or with
 * `--check` checks every kept page once and stops.
 *
 * The config is loaded with `source.dir` required to exist, and
 * `discovery.json` must exist in it. `D2C_PORT` is read from
 * `options.env`, unless `options.port` (a seam for tests) names the port. Only a {@link ProjectConfigError}, a missing
 * `discovery.json` or a {@link ServePortError} is turned into output; any
 * other error propagates, after stopping a server the verb started.
 *
 * @param flags - The parsed flags.
 * @param options - The environment and root the loader reads from, and the
 *   page checker `--check` runs, and the test-only port.
 * @returns Without `--check`, the address on stdout with exit 0 and a
 *   `stop` handle for the running server; with `--check`, a summary on
 *   stdout and exit 0 when every page is clean, or exit 1 with the pages
 *   that have problems on stderr; a failure as `d2c serve: <message>` on
 *   stderr with exit 1.
 */
export async function runServe(flags: ServeArguments, options: ServeOptions): Promise<CliResult> {
  const { checkPages, port, ...loadOptions } = options;
  const rootDir = loadOptions.rootDir ?? REPO_ROOT;

  try {
    const config = loadProjectConfig(loadOptions);
    const sourceDir = resolve(rootDir, config.source.dir);

    assertDiscovery(sourceDir, config.source.dir);

    if (flags.check) {
      const server = await startServer({ sourceDir, port, env: loadOptions.env });
      const report = await checkAndStop(server, checkPages, {
        sourceDir,
        address: server.address,
        pages: config.pages,
      });

      return checkResult(report, join(config.source.dir, basename(serveCheckPath(sourceDir))));
    }

    const server = await startServer({
      sourceDir,
      port,
      env: loadOptions.env,
      readPages: () => loadProjectConfig(loadOptions).pages,
      savePage: (page, choice) => savePageChoice(config.slug, page, choice, { rootDir }),
    });

    return {
      exitCode: 0,
      stdout: `d2c ${VERB}: serving ${config.source.dir} at ${server.address}\n`,
      stderr: '',
      stop: server.stop,
    };
  } catch (error) {
    if (isReportedError(error)) {
      return verbFailure(VERB, error.message);
    }

    throw error;
  }
}
