/**
 * The `config` verb: `d2c config`.
 *
 * Loads the active project's config and prints it as JSON with every
 * default filled in.
 *
 * @packageDocumentation
 */

import type { CliResult } from './result.ts';
import type { LoadOptions } from '../../config/load.ts';

import { loadProjectConfig, ProjectConfigError } from '../../config/load.ts';

/** The indent of the JSON the `config` verb prints. */
const JSON_INDENT = 2;

/**
 * The `config` verb: loads the active project's config and prints it.
 *
 * Only a {@link ProjectConfigError} is turned into output; any other error
 * (a permission or I/O failure) is not a problem with the config and
 * propagates.
 *
 * @param options - The environment and root the loader reads from.
 * @returns The config as indented JSON on stdout with exit 0, or the
 *   loader's field-naming message on stderr with exit 1.
 */
export function runConfig(options: LoadOptions): CliResult {
  try {
    const config = loadProjectConfig(options);

    return {
      exitCode: 0,
      stdout: `${JSON.stringify(config, null, JSON_INDENT)}\n`,
      stderr: '',
    };
  } catch (error) {
    if (error instanceof ProjectConfigError) {
      return { exitCode: 1, stdout: '', stderr: `d2c config: ${error.message}\n` };
    }

    throw error;
  }
}
