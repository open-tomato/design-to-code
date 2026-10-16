/**
 * The usage text `bin/d2c.ts` prints for a help request or an unknown
 * verb, and the arguments that count as a help request.
 *
 * @packageDocumentation
 */

/** The usage text printed for a help request or an unknown verb. */
export const USAGE = [
  'Usage: bun run d2c <verb> [options]',
  '',
  'Extracts a component library from a design export.',
  'The active project is read from D2C_PROJECT (projects/<slug>.json).',
  '',
  'Verbs:',
  '  config  Print the active project\'s config as JSON, defaults filled in',
  '  import  Import a design export into the project\'s source.dir',
  '          --source=<path>  A folder or a .zip file (required)',
  '          --force          Empty a non-empty source.dir first',
  '  assess  Write <source.dir>/discovery.json, then merge in agent notes',
  '          from claude -p',
  '          --scripts-only   Write the scripts\' report; skip the agent',
  '  serve   Serve source.dir at http://127.0.0.1:<port>/ with a nav bar',
  '          and page curation until interrupted; D2C_PORT names the port,',
  '          else the first free one from 4600 to 4699',
  '          --check          Load every kept page headless, write',
  '                           <source.dir>/serve-check.json, exit 1 on',
  '                           any problem',
  '  baseline confirm  Ask, per kept page, whether it works as in Claude',
  '          Design; write <baselineDir>/confirmed.json',
  '  baseline capture  Capture every confirmed kept page twice per',
  '          viewport; write the baseline, exit 1 on any flaky capture',
  '  seed    Write <source.dir>/seed-manifest.json and seed-rejected.json',
  '          from the kept pages\' markers, else from claude -p',
  '  gates   Run the structure, state-coverage, build-lint and',
  '          story-health gates over target.dir, in that order; write',
  '          <target.dir>/gate-results/<component>/<gate>.json, exit 1',
  '          on any failed gate',
  '          --local          Run the local gates (required)',
  '  help    Print this message',
  '',
  'Exit codes:',
  '  0  The verb succeeded',
  '  1  The verb refused: a usage error, a bad config, or an import,',
  '     assess, serve, baseline, seed or gates refusal, printed on',
  '     stderr without a stack; or a gate failed',
  '  2  An unexpected failure, printed with its stack on stderr',
  '',
  'No extraction verb is implemented yet.',
].join('\n');

/** The arguments that ask for the usage text instead of naming a verb. */
export const HELP_ARGUMENTS: ReadonlySet<string> = new Set(['help', '-h', '--help']);
