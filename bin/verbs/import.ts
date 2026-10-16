/**
 * The `import` verb: `d2c import --source=<path> [--force]`.
 *
 * Imports a folder or a `.zip` into the active project's `source.dir`,
 * which need not exist yet, and writes the import record.
 *
 * @packageDocumentation
 */

import type { CliResult } from './result.ts';
import type { LoadOptions } from '../../config/load.ts';

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { loadProjectConfig, ProjectConfigError, REPO_ROOT } from '../../config/load.ts';
import { ImportError, importSource } from '../../pipeline/import/index.ts';

import { isParseArgsError, verbFailure } from './result.ts';

/** The verb's name, as typed on the command line and printed in output. */
const VERB = 'import';

/** The options the `import` verb accepts, in `node:util` `parseArgs` form. */
const IMPORT_OPTIONS = {
  source: { type: 'string' },
  force: { type: 'boolean', default: false },
} as const;

/** The flags of one `import` invocation. */
export interface ImportArguments {
  readonly source: string;
  readonly force: boolean;
}

/**
 * Parses the `import` verb's arguments; a string is the usage error's
 * message.
 */
export function parseImportArguments(args: readonly string[]): ImportArguments | string {
  let values: { source?: string; force: boolean };

  try {
    ({ values } = parseArgs({ args: [...args], options: IMPORT_OPTIONS, strict: true, allowPositionals: false }));
  } catch (error) {
    if (isParseArgsError(error)) {
      return error.message;
    }

    throw error;
  }

  if (values.source === undefined || values.source === '') {
    return '--source=<path> is required';
  }

  return { source: values.source, force: values.force };
}

/**
 * The `import` verb: imports `flags.source` into the active project's
 * `source.dir`, resolved against the root, emptying it first with
 * `flags.force`.
 *
 * The config is loaded with `requireSourceDir: false`, since the import
 * creates the directory. A relative `flags.source` resolves against the
 * working directory; the record keeps it as given. Only a
 * {@link ProjectConfigError} or an {@link ImportError} is turned into
 * output; any other error propagates.
 *
 * @param flags - The parsed flags.
 * @param options - The environment and root the loader reads from.
 * @returns A summary on stdout with exit 0; a usage error, or the
 *   config's or the import's message, on stderr with exit 1.
 */
export function runImport(flags: ImportArguments, options: LoadOptions): CliResult {
  try {
    const config = loadProjectConfig({ ...options, requireSourceDir: false });
    const sourceDir = resolve(options.rootDir ?? REPO_ROOT, config.source.dir);
    const record = importSource({ source: flags.source, sourceDir, force: flags.force });

    return {
      exitCode: 0,
      stdout: `d2c ${VERB}: ${record.files.length} files (${record.kind}) imported into ${config.source.dir}\n`,
      stderr: '',
    };
  } catch (error) {
    if (error instanceof ProjectConfigError || error instanceof ImportError) {
      return verbFailure(VERB, error.message);
    }

    throw error;
  }
}
