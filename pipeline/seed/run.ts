/**
 * The seed run: the one place that owns the server and the browser, and
 * the only one that writes `seed-manifest.json` and `seed-rejected.json`.
 *
 * {@link runSeed} does every check that needs no browser first, and
 * refuses with a {@link SeedRefusedError} before a server starts: no
 * `discovery.json` (or one that fails its schema), naming
 * {@link DISCOVERY_COMMAND}; no kept page once `pages.discard` is applied.
 * It also reads every design-system manifest discovery found, so an
 * unreadable one throws its `DsManifestError` before anything is served.
 *
 * Then it serves `source.dir`, launches headless Chromium, and stops both
 * in a `finally`, whatever happens in between:
 *
 * 1. Each kept page is loaded once and split by its rendered DOM: a page
 *    holding a `data-component` element is marked, and its markers are
 *    read; a page holding none is unmarked, and its DOM outline is read.
 *    Marker reads are combined in page path order, and a name already
 *    read on an earlier page is ignored on a later one.
 * 2. The design-system manifests are merged with the marker reads.
 * 3. The agent runs exactly once, over the outlines of every unmarked page
 *    together, and only when an unmarked page exists.
 * 4. Every candidate, whichever path proposed it, is validated against the
 *    served page it names.
 * 5. The accepted entries are put in extraction order, and the order is
 *    checked against the DOM containment among them, read in one more load
 *    of each page that has an accepted entry.
 *
 * A run with no accepted entry is refused with a {@link SeedRefusedError}
 * carrying its rejections, and writes neither file. Otherwise both files
 * are written under one `generatedAt`, the rejected one with an empty list
 * when nothing was rejected, so a stale one never survives. Rejections are
 * listed in the order they arose: the marker and manifest reads, the
 * agent's shape check, then validation.
 *
 * @packageDocumentation
 */

import type { MarkedComponents } from './markers.ts';
import type { DomOutline } from './outline.ts';
import type { ComponentEntry, RejectedCandidate, SeedManifest, SeedRejected } from './schema.ts';
import type { AgentSpawner } from '../assess/agent.ts';
import type { DiscoveryReport } from '../assess/schema.ts';
import type { PagesConfig } from '../serve/nav.ts';
import type { Browser } from 'playwright';

import { readFileSync } from 'node:fs';

import { chromium } from 'playwright';

import { discoveryPath } from '../assess/discover.ts';
import { discoveryReportSchema } from '../assess/schema.ts';
import { keptPages } from '../serve/check.ts';
import { startServer } from '../serve/server.ts';

import { runSeedAgent } from './agent.ts';
import { mergeDsManifests, readDsManifests } from './ds-manifest.ts';
import { writeSeedManifest, writeSeedRejected } from './files.ts';
import { hasComponentMarkers, readMarkedComponents } from './markers.ts';
import { assertContainmentOrder, extractionOrder } from './order.ts';
import { readDomOutline } from './outline.ts';
import { withSeedPage } from './page.ts';
import { seedManifestSchema, seedRejectedSchema } from './schema.ts';
import { validateCandidates } from './validate.ts';

/** The command that writes the `discovery.json` seed reads. */
export const DISCOVERY_COMMAND = 'bun run d2c assess --scripts-only';

/**
 * A refusal by the seed run: no valid `discovery.json`, no kept page, or no
 * accepted entry. Its message is ready to print as it stands.
 */
export class SeedRefusedError extends Error {
  override readonly name = 'SeedRefusedError';

  /** Every rejection of a run refused for having no accepted entry; `[]` for any other refusal. */
  readonly rejected: readonly RejectedCandidate[];

  constructor(message: string, rejected: readonly RejectedCandidate[] = []) {
    super(message);
    this.rejected = rejected;
  }
}

/** What {@link runSeed} reads. */
export interface RunSeedOptions {
  /** The project's `source.dir`, resolved. */
  readonly sourceDir: string;
  /** The project config's `pages`; its `discard` list removes pages from the run. */
  readonly pages: PagesConfig;
  /** Runs the agent once on a built prompt; called only when a kept page is unmarked. */
  readonly spawn: AgentSpawner;
  /** The clock `generatedAt` is read from; the system clock by default. */
  readonly now?: () => Date;
  /** The environment the server reads `D2C_PORT` from; `process.env` by default. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * A seam for tests, with no CLI flag: the port the server binds, passed
   * to `startServer` as its `port`, so it outranks `D2C_PORT` and never
   * falls back. `0` has the operating system assign a free port. Unset,
   * `D2C_PORT` and then the 4600 range apply.
   */
  readonly port?: number;
}

/** What {@link runSeed} wrote and found. */
export interface RunSeedResult {
  /** The manifest as written, components in extraction order. */
  readonly manifest: SeedManifest;
  /** Every rejected candidate, as written to `seed-rejected.json`. */
  readonly rejected: readonly RejectedCandidate[];
  /** True when the agent was run, which is when at least one kept page is unmarked. */
  readonly agentRan: boolean;
}

/** One kept page's read: its markers when it is marked, its outline when not. */
type PageRead =
  | { readonly kind: 'marked'; readonly markers: MarkedComponents }
  | { readonly kind: 'unmarked'; readonly outline: DomOutline };

/** The candidates the marker, manifest and agent paths proposed, and their rejections so far. */
interface Proposals {
  readonly candidates: readonly ComponentEntry[];
  readonly rejected: readonly RejectedCandidate[];
  readonly agentRan: boolean;
}

/** An accepted entry's name and root selector, as the containment reader takes them. */
interface RootProbe {
  readonly name: string;
  readonly selector: string;
}

/**
 * Reads and validates `<sourceDir>/discovery.json`.
 *
 * @throws SeedRefusedError naming {@link DISCOVERY_COMMAND} when the file
 * cannot be read, is not JSON or fails the discovery report schema.
 */
function readDiscovery(sourceDir: string): DiscoveryReport {
  const path = discoveryPath(sourceDir);
  let text: string;

  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new SeedRefusedError(
      `cannot read ${path}; run \`${DISCOVERY_COMMAND}\` first: ${(error as Error).message}`,
    );
  }

  let parsed: ReturnType<typeof discoveryReportSchema.safeParse>;

  try {
    parsed = discoveryReportSchema.safeParse(JSON.parse(text));
  } catch (error) {
    throw new SeedRefusedError(
      `${path} is not valid JSON; run \`${DISCOVERY_COMMAND}\` again: ${(error as Error).message}`,
    );
  }

  if (!parsed.success) {
    throw new SeedRefusedError(
      `${path} is not a valid discovery report; run \`${DISCOVERY_COMMAND}\` again: ${parsed.error.message}`,
    );
  }

  return parsed.data;
}

/** Loads `pagePath` once and reads its markers when it holds any, its outline otherwise. */
function readPage(browser: Browser, address: string, pagePath: string): Promise<PageRead> {
  return withSeedPage(browser, address, pagePath, async (page) => (await hasComponentMarkers(page)
    ? { kind: 'marked', markers: await readMarkedComponents(page, pagePath) }
    : { kind: 'unmarked', outline: await readDomOutline(page, pagePath) }));
}

/** The name a marker read's candidate or rejection carries, when it carries one. */
function markedName(value: ComponentEntry | RejectedCandidate): string | undefined {
  const named = 'reasons' in value
    ? value.candidate
    : value;

  return typeof named === 'object' && named !== null && !Array.isArray(named) && typeof named.name === 'string'
    ? named.name
    : undefined;
}

/** The marker reads combined so far, and every name they hold. */
interface CombinedReads {
  readonly seen: ReadonlySet<string>;
  readonly markers: MarkedComponents;
}

/** Adds one page's marker read to `combined`, ignoring every name an earlier page read. */
function addMarkerRead(combined: CombinedReads, read: MarkedComponents): CombinedReads {
  const isNew = (value: ComponentEntry | RejectedCandidate): boolean => {
    const name = markedName(value);

    return name === undefined || !combined.seen.has(name);
  };
  const names = [...read.candidates, ...read.rejected]
    .map(markedName)
    .filter((name): name is string => name !== undefined);

  return {
    seen: new Set([...combined.seen, ...names]),
    markers: {
      candidates: [...combined.markers.candidates, ...read.candidates.filter(isNew)],
      rejected: [...combined.markers.rejected, ...read.rejected.filter(isNew)],
    },
  };
}

/**
 * Combines the marker reads of several pages, given in page path order:
 * a candidate or rejection whose name an earlier page already read is
 * ignored.
 */
function combineMarkerReads(reads: readonly MarkedComponents[]): MarkedComponents {
  const empty: CombinedReads = { seen: new Set<string>(), markers: { candidates: [], rejected: [] } };

  return reads.reduce(addMarkerRead, empty).markers;
}

/**
 * Reads every kept page, merges the design-system manifests with the
 * marker reads, and runs the agent once over the unmarked pages, if any.
 */
async function propose(
  browser: Browser,
  address: string,
  pagePaths: readonly string[],
  discovery: DiscoveryReport,
  manifests: ReturnType<typeof readDsManifests>,
  spawn: AgentSpawner,
): Promise<Proposals> {
  const reads = await Promise.all(pagePaths.map((pagePath) => readPage(browser, address, pagePath)));
  const markers = combineMarkerReads(reads.flatMap((read) => (read.kind === 'marked'
    ? [read.markers]
    : [])));
  const outlines = reads.flatMap((read) => (read.kind === 'unmarked'
    ? [read.outline]
    : []));
  const merged = mergeDsManifests(manifests, markers);

  if (outlines.length === 0) {
    return { ...merged, agentRan: false };
  }

  const agent = await runSeedAgent(outlines, discovery, spawn);

  return {
    candidates: [...merged.candidates, ...agent.candidates],
    rejected: [...merged.rejected, ...agent.rejected],
    agentRan: true,
  };
}

/**
 * Runs in the page: for each probe, the names of the other probes whose
 * root its root contains. Self-contained, since Playwright sends its source.
 */
function readContainmentInPage(probes: readonly RootProbe[]): [string, string[]][] {
  const roots = probes.map((probe) => ({ name: probe.name, element: document.querySelector(probe.selector) }));

  return roots.map((outer) => [
    outer.name,
    roots
      .filter((inner) => inner !== outer
        && outer.element !== null
        && inner.element !== null
        && outer.element.contains(inner.element))
      .map((inner) => inner.name),
  ]);
}

/** Maps each accepted entry's name to the names of the accepted entries its root contains. */
async function readContainment(
  browser: Browser,
  address: string,
  entries: readonly ComponentEntry[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  const pagePaths = [...new Set(entries.map((entry) => entry.page))].sort();
  const perPage = await Promise.all(pagePaths.map((pagePath) => withSeedPage(
    browser,
    address,
    pagePath,
    (page) => page.evaluate(readContainmentInPage, entries
      .filter((entry) => entry.page === pagePath)
      .map((entry) => ({ name: entry.name, selector: entry.selector }))),
  )));

  return new Map(perPage.flat());
}

/** A count of each reason code across `rejected`, such as `selector-multi-match ×2`. */
function reasonSummary(rejected: readonly RejectedCandidate[]): string {
  const counts = rejected
    .flatMap((candidate) => candidate.reasons.map((reason) => reason.code))
    .reduce((tally, code) => new Map([...tally, [code, (tally.get(code) ?? 0) + 1]]), new Map<string, number>());

  return [...counts].map(([code, count]) => `${code} ×${count}`)
    .join(', ');
}

/** Proposes, validates and orders the entries, with the server and browser running. */
async function seedServed(options: RunSeedOptions, pagePaths: readonly string[], discovery: DiscoveryReport) {
  const manifests = readDsManifests(options.sourceDir, discovery.knownFiles);
  const server = await startServer({ sourceDir: options.sourceDir, port: options.port, env: options.env });

  try {
    const browser = await chromium.launch();

    try {
      const proposals = await propose(browser, server.address, pagePaths, discovery, manifests, options.spawn);
      const validation = await validateCandidates(browser, server.address, pagePaths, proposals.candidates);
      const rejected = [...proposals.rejected, ...validation.rejected];

      if (validation.accepted.length === 0) {
        const reasons = rejected.length === 0
          ? 'no candidate was proposed'
          : `${rejected.length} candidates rejected (${reasonSummary(rejected)})`;

        throw new SeedRefusedError(`no component entry was accepted: ${reasons}; nothing was written`, rejected);
      }

      const components = extractionOrder(validation.accepted);

      assertContainmentOrder(components, await readContainment(browser, server.address, components));

      return { components, rejected, agentRan: proposals.agentRan };
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop();
  }
}

/**
 * Seeds the component manifest of the export under `options.sourceDir`,
 * per this module's documentation, and writes `seed-manifest.json` and
 * `seed-rejected.json` beside `discovery.json`.
 *
 * @returns The manifest and rejections as written, and whether the agent ran.
 * @throws SeedRefusedError before any server starts when `discovery.json` is
 * missing or invalid or no page is kept, and after the run, with nothing
 * written, when no entry was accepted.
 * @throws DsManifestError before any server starts when a design-system
 * manifest discovery found cannot be read.
 * @throws AgentOutputError when the agent's answer holds no
 * `{ "components": [...] }` object, and whatever the spawner throws; nothing
 * is written then.
 * @throws Error when a kept page does not load or settle, when Chromium
 * cannot be launched (install it with `bun run setup`), or when the server
 * cannot bind a port.
 */
export async function runSeed(options: RunSeedOptions): Promise<RunSeedResult> {
  const discovery = readDiscovery(options.sourceDir);
  const pagePaths = keptPages(options.sourceDir, options.pages);

  if (pagePaths.length === 0) {
    const why = discovery.pages.length === 0
      ? 'discovery found no page'
      : `pages.discard lists all ${discovery.pages.length} pages discovery found`;

    throw new SeedRefusedError(`no page is kept in ${options.sourceDir}: ${why}`);
  }

  const { components, rejected, agentRan } = await seedServed(options, pagePaths, discovery);
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  const manifest = seedManifestSchema.parse({ generatedAt, components });
  const rejectedFile: SeedRejected = seedRejectedSchema.parse({ generatedAt, rejected });

  writeSeedManifest(options.sourceDir, manifest);
  writeSeedRejected(options.sourceDir, rejectedFile);

  return { manifest, rejected: rejectedFile.rejected, agentRan };
}
