/**
 * The `baseline` verb: `d2c baseline confirm` and `d2c baseline capture`.
 *
 * Both load the active project (with `source.dir` required to exist),
 * refuse without `<source.dir>/discovery.json`, and hand the rest to
 * `pipeline/baseline/`: `runConfirm` and `runCapture` each start their own
 * server over `source.dir` with `startServer`, under the same `D2C_PORT`
 * rules as `serve`, and stop it in a `finally`. `baselineDir` resolves
 * against the loader's root directory; an absolute one is used as is.
 *
 * `confirm` asks, for every kept page the share link does not confirm,
 * whether the served page works as in Claude Design, and writes each answer
 * to `<baselineDir>/confirmed.json`. What confirm prints before a question
 * (the page's `serve --check` findings, the share-link outcomes) is handed
 * to the {@link BaselinePrompter} as the lines before the question, so the
 * person reads it before answering; what it prints after the last question
 * goes to stdout with a summary. It exits 0 when every kept page is
 * confirmed and 1 naming the pages left unconfirmed.
 *
 * `capture` double-captures every confirmed kept page at every configured
 * viewport and writes the baseline under
 * `<baselineDir>/<playwright version>/<import hash>/`. It exits 0 when
 * every page and viewport captured, and 1 naming each flaky page, viewport
 * and region, the rest written.
 *
 * A known refusal (a bad config, a taken port, no `discovery.json`, no
 * import record, an invalid `confirmed.json`, unset `viewports`, no kept
 * page, an unconfirmed page, a baseline path outside its directory) is
 * printed as `d2c baseline: <message>` with exit 1 and nothing written.
 *
 * @packageDocumentation
 */

import type { CliResult } from './result.ts';
import type { PageChecker } from './serve.ts';
import type { LoadOptions } from '../../config/load.ts';
import type { ProjectConfig } from '../../config/schema.ts';
import type { OpenedPage, PageOpener, Prompter } from '../../pipeline/baseline/confirm.ts';
import type { FlakyCapture } from '../../pipeline/baseline/run-capture.ts';

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

import { chromium } from 'playwright';

import { loadProjectConfig, ProjectConfigError, REPO_ROOT } from '../../config/load.ts';
import { discoveryPath } from '../../pipeline/assess/discover.ts';
import { ConfirmRefusedError, runConfirm } from '../../pipeline/baseline/confirm.ts';
import { ConfirmedFileError, confirmedPath } from '../../pipeline/baseline/confirmed.ts';
import { BaselinePathError, MissingImportRecordError } from '../../pipeline/baseline/key.ts';
import { CaptureRefusedError, capturePath, flakyCaptures, runCapture } from '../../pipeline/baseline/run-capture.ts';
import { ServePortError } from '../../pipeline/serve/port.ts';

import { isParseArgsError, verbFailure } from './result.ts';
import { DISCOVERY_COMMAND, MissingDiscoveryError } from './serve.ts';

/** The verb's name, as typed on the command line and printed in output. */
const VERB = 'baseline';

/** The subcommands `baseline` accepts. */
export const BASELINE_SUBCOMMANDS = ['confirm', 'capture'] as const;

/** One of {@link BASELINE_SUBCOMMANDS}. */
export type BaselineSubcommand = typeof BASELINE_SUBCOMMANDS[number];

/** The subcommand of one `baseline` invocation. */
export interface BaselineArguments {
  readonly subcommand: BaselineSubcommand;
}

/**
 * Asks the person a question and resolves their answer as typed; the text
 * holds whatever confirm printed since the last question, then the question.
 */
export type BaselinePrompter = Prompter;

/** What the `baseline` verb reads from and how it talks to the person. */
export interface BaselineOptions extends LoadOptions {
  /** The `serve --check` page checker `confirm` runs. */
  readonly checkPages: PageChecker;
  /** Opens a served page for the person during `confirm`. */
  readonly openPage: PageOpener;
  /** Asks the person about a page during `confirm`. */
  readonly prompt: BaselinePrompter;
}

/** Whether `value` names one of {@link BASELINE_SUBCOMMANDS}. */
function isSubcommand(value: string): value is BaselineSubcommand {
  return (BASELINE_SUBCOMMANDS as readonly string[]).includes(value);
}

/**
 * Parses the `baseline` verb's arguments: exactly one subcommand, no options.
 *
 * @param args - The arguments after `baseline`.
 * @returns The subcommand, or the usage error's message as a string.
 */
export function parseBaselineArguments(args: readonly string[]): BaselineArguments | string {
  let positionals: string[];

  try {
    ({ positionals } = parseArgs({ args: [...args], options: {}, strict: true, allowPositionals: true }));
  } catch (error) {
    if (isParseArgsError(error)) {
      return error.message;
    }

    throw error;
  }

  const [subcommand, ...extra] = positionals;

  if (subcommand === undefined) {
    return `missing subcommand; expected one of ${BASELINE_SUBCOMMANDS.join(', ')}`;
  }

  if (!isSubcommand(subcommand)) {
    return `unknown subcommand '${subcommand}'; expected one of ${BASELINE_SUBCOMMANDS.join(', ')}`;
  }

  if (extra.length > 0) {
    return `unexpected argument '${extra[0]}'`;
  }

  return { subcommand };
}

/** The error classes the verb prints rather than propagates. */
const REPORTED_ERRORS: readonly (abstract new (...args: never[]) => Error)[] = [
  ProjectConfigError,
  ServePortError,
  MissingDiscoveryError,
  MissingImportRecordError,
  ConfirmedFileError,
  ConfirmRefusedError,
  CaptureRefusedError,
  BaselinePathError,
];

/** Whether `error` is one the verb prints rather than propagates. */
function isReportedError(error: unknown): error is Error {
  return REPORTED_ERRORS.some((errorClass) => error instanceof errorClass);
}

/** The project's resolved paths and the config fields the subcommands read. */
interface Project {
  readonly config: ProjectConfig;
  readonly rootDir: string;
  readonly sourceDir: string;
  readonly baselineRoot: string;
}

/** Loads the project and refuses without `discovery.json`. */
function loadProject(options: LoadOptions): Project {
  const rootDir = options.rootDir ?? REPO_ROOT;
  const config = loadProjectConfig(options);
  const sourceDir = resolve(rootDir, config.source.dir);

  if (!existsSync(discoveryPath(sourceDir))) {
    throw new MissingDiscoveryError(
      `${config.source.dir}/discovery.json not found; run '${DISCOVERY_COMMAND}' first`,
    );
  }

  return { config, rootDir, sourceDir, baselineRoot: resolve(rootDir, config.baselineDir) };
}

/** Runs `confirm`, lines printed before a question handed to the prompter with it. */
async function confirm(project: Project, options: BaselineOptions): Promise<CliResult> {
  const { config, rootDir, sourceDir, baselineRoot } = project;
  let pending: string[] = [];
  const result = await runConfirm({
    sourceDir,
    baselineDir: config.baselineDir,
    rootDir,
    pages: config.pages,
    viewports: config.viewports,
    shareLink: config.source.shareLink,
    openPage: options.openPage,
    prompt: async (question) => {
      const text = [...pending, question].join('\n');

      pending = [];

      return options.prompt(text);
    },
    print: (text) => {
      pending = [...pending, text];
    },
    checkPages: options.checkPages,
    env: options.env,
  });
  const unconfirmed = result.pages.filter((page) => page.status === 'unconfirmed').map((page) => page.page);
  const confirmedCount = result.pages.length - unconfirmed.length;
  const printed = pending.map((line) => `${line}\n`).join('');
  const stdout = `${printed}d2c ${VERB}: confirmed ${confirmedCount} of ${result.pages.length} kept pages; wrote ${confirmedPath(baselineRoot)}\n`;

  if (unconfirmed.length === 0) {
    return { exitCode: 0, stdout, stderr: '' };
  }

  return {
    exitCode: 1,
    stdout,
    stderr: `d2c ${VERB}: ${unconfirmed.length} kept pages left unconfirmed: ${unconfirmed.join(', ')}\n`,
  };
}

/** One flaky page and viewport as one line. */
function flakyLine({ page, viewport, differingPixels, region }: FlakyCapture): string {
  return `  ${page} at ${viewport}: ${differingPixels} differing pixels in `
    + `{ x: ${region.x}, y: ${region.y}, width: ${region.width}, height: ${region.height} }`;
}

/** Runs `capture`. */
async function capture(project: Project, options: LoadOptions): Promise<CliResult> {
  const { config, rootDir, sourceDir } = project;
  const { keyDir, record } = await runCapture({
    sourceDir,
    baselineDir: config.baselineDir,
    rootDir,
    pages: config.pages,
    viewports: config.viewports,
    env: options.env,
  });
  const flaky = flakyCaptures(record);
  const stdout = `d2c ${VERB}: captured ${record.pages.length} pages under ${keyDir}; wrote ${capturePath(keyDir)}\n`;

  if (flaky.length === 0) {
    return { exitCode: 0, stdout, stderr: '' };
  }

  return {
    exitCode: 1,
    stdout,
    stderr: [`d2c ${VERB}: ${flaky.length} page captures are flaky; no baseline was written for them:`, ...flaky.map(flakyLine), ''].join('\n'),
  };
}

/**
 * The `baseline` verb: confirms the kept pages or captures their baseline.
 *
 * @param parsed - The parsed subcommand.
 * @param options - The environment and root the loader reads from, the
 *   page checker, and the page opener and prompter `confirm` uses.
 * @returns The subcommand's summary on stdout, exit 0 when it finished
 *   clean, else exit 1 with the unconfirmed or flaky pages on stderr; a
 *   known refusal as `d2c baseline: <message>` on stderr with exit 1.
 * @throws Error for anything else: a browser that does not launch, a page
 *   that does not load, a prompter that fails.
 */
export async function runBaseline(parsed: BaselineArguments, options: BaselineOptions): Promise<CliResult> {
  const { checkPages, openPage, prompt, ...loadOptions } = options;

  try {
    const project = loadProject(loadOptions);

    return parsed.subcommand === 'confirm'
      ? await confirm(project, { ...loadOptions, checkPages, openPage, prompt })
      : await capture(project, loadOptions);
  } catch (error) {
    if (isReportedError(error)) {
      return verbFailure(VERB, error.message);
    }

    throw error;
  }
}

/**
 * The CLI's default page opener: the page in its own headed Chromium
 * window, closed with the browser once the person has answered.
 */
export const headedPageOpener: PageOpener = async ({ url }): Promise<OpenedPage> => {
  const browser = await chromium.launch({ headless: false });

  try {
    const page = await browser.newPage();

    await page.goto(url);
  } catch (error) {
    await browser.close();
    throw error;
  }

  return { close: () => browser.close() };
};

/** The CLI's default prompter: one `node:readline` question on stdin and stdout. */
export const readlinePrompter: BaselinePrompter = async (question) => {
  const readline = createInterface({ input: process.stdin, output: process.stdout });

  try {
    return await readline.question(question);
  } finally {
    readline.close();
  }
};
