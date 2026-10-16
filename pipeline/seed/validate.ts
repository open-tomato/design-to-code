/**
 * Validation of seed candidates against the served pages they name: no
 * selector reaches the extraction loop unchecked, whichever path proposed
 * it.
 *
 * {@link validateCandidates} runs the checks in a fixed order, and a
 * candidate collects every reason that applies at the first step it fails,
 * then goes no further:
 *
 * 1. shape — the candidate parses as a {@link componentEntrySchema} entry,
 *    else one `invalid-shape` reason listing the zod issues;
 * 2. duplicate name — no shape-valid candidate earlier in the list has the
 *    same name, else `duplicate-name`;
 * 3. kept page — `page` is one of the kept pages, else `page-not-kept`;
 * 4. selector — `selector` matches exactly one element on `page`, else
 *    `selector-no-match` (none, or not a valid selector) or
 *    `selector-multi-match` with the count;
 * 5. examples — each example matches at least one element, else one
 *    `example-no-match` per example that does not;
 * 6. states — each `example` state's selector matches at least one
 *    element, and each `action` state's target exactly one element inside
 *    the component, the root itself included, else one `state-unresolved`
 *    per state that does not;
 * 7. containment — among the entries that passed every step so far on the
 *    same page, an entry whose root contains the root of another entry of
 *    equal or higher level is rejected with one `contains-equal-or-higher`
 *    per such entry, naming it. Containment is DOM containment, so two
 *    entries with the same root element contain each other.
 *
 * Steps 1 to 3 need no browser. Steps 4 to 7 load each page that still
 * has a candidate once, through {@link withSeedPage}, and read every
 * selector of that page's candidates in one in-page evaluation. A
 * selector is only ever checked on the page its candidate names, never on
 * another.
 *
 * Accepted entries come back as parsed, in input order; rejections carry
 * the candidate as proposed, in input order. The module reads pages and
 * writes nothing.
 *
 * @packageDocumentation
 */

import type { ComponentEntry, RejectedCandidate, RejectionReason } from './schema.ts';
import type { Browser } from 'playwright';

import { z } from 'zod';

import { withSeedPage } from './page.ts';
import { componentEntrySchema, levelRank } from './schema.ts';

/** The candidates that passed every check, and the rest with their reasons. */
export interface ValidationResult {
  /** Entries that passed every step, as parsed, in input order. */
  readonly accepted: readonly ComponentEntry[];
  /** Candidates that failed a step, as proposed, in input order, each with its reasons. */
  readonly rejected: readonly RejectedCandidate[];
}

/** Any JSON value, as a rejected candidate keeps it. */
type Json = RejectedCandidate['candidate'];

/** One candidate after the steps that need no browser. */
type StaticOutcome =
  | { readonly kind: 'rejected'; readonly reasons: readonly RejectionReason[] }
  | { readonly kind: 'pending'; readonly entry: ComponentEntry };

/** What the page is asked about one entry. */
interface SelectorProbe {
  readonly selector: string;
  readonly examples: readonly string[];
  readonly states: readonly { readonly mode: 'example' | 'action'; readonly selector: string }[];
}

/**
 * What the page answered about one entry. A count is `null` when its
 * selector is not valid CSS. `stateCounts` and `contains` are only read
 * when the root matched exactly once.
 */
interface SelectorReading {
  /** How many elements `selector` matches in the document. */
  readonly selectorCount: number | null;
  /** Per example, how many elements it matches in the document. */
  readonly exampleCounts: readonly (number | null)[];
  /** Per state: an example's document matches, an action target's matches in the root. */
  readonly stateCounts: readonly (number | null)[];
  /** Indices of the other entries whose unique root lies inside this entry's unique root. */
  readonly contains: readonly number[];
}

/** One rejection reason. */
function reason(code: RejectionReason['code'], detail: string): RejectionReason {
  return { code, detail };
}

/** The candidate as JSON for `seed-rejected.json`; a value that is not JSON is kept as its string. */
function asJson(candidate: unknown): Json {
  const parsed = z.json().safeParse(candidate);

  return parsed.success
    ? parsed.data
    : String(candidate);
}

/** Steps 1 to 3: shape, duplicate name and kept page, judged over the whole list. */
function checkStatically(keptPages: readonly string[], candidates: readonly unknown[]): readonly StaticOutcome[] {
  const parsed = candidates.map((candidate) => componentEntrySchema.safeParse(candidate));

  return parsed.map((result, index): StaticOutcome => {
    if (!result.success) {
      return { kind: 'rejected', reasons: [reason('invalid-shape', z.prettifyError(result.error))] };
    }

    const entry = result.data;
    const firstIndex = parsed.findIndex((other) => other.success && other.data.name === entry.name);
    const first = parsed[firstIndex];

    if (firstIndex !== index && first?.success === true) {
      return {
        kind: 'rejected',
        reasons: [reason(
          'duplicate-name',
          `name "${entry.name}" is already taken by the candidate at "${first.data.selector}" on ${first.data.page}`,
        )],
      };
    }

    if (!keptPages.includes(entry.page)) {
      return { kind: 'rejected', reasons: [reason('page-not-kept', `page ${entry.page} is not a kept page`)] };
    }

    return { kind: 'pending', entry };
  });
}

/**
 * Runs in the page: counts every selector of every probe, and records
 * which unique roots contain which. Self-contained, since Playwright sends
 * its source to the page.
 */
function readSelectorsInPage(probes: readonly SelectorProbe[]): SelectorReading[] {
  const all = (scope: Document | Element, selector: string): Element[] | null => {
    try {
      return [...scope.querySelectorAll(selector)];
    } catch {
      return null;
    }
  };
  const countIn = (root: Element, selector: string): number | null => {
    const inside = all(root, selector);

    return inside === null
      ? null
      : inside.length + (root.matches(selector)
        ? 1
        : 0);
  };
  const rootMatches = probes.map((probe) => all(document, probe.selector));
  const roots = rootMatches.map((matches) => (matches?.length === 1
    ? matches[0] ?? null
    : null));

  return probes.map((probe, index) => {
    const root = roots[index] ?? null;

    return {
      selectorCount: rootMatches[index]?.length ?? null,
      exampleCounts: probe.examples.map((example) => all(document, example)?.length ?? null),
      stateCounts: probe.states.map((state) => {
        if (state.mode === 'example') {
          return all(document, state.selector)?.length ?? null;
        }

        return root === null
          ? 0
          : countIn(root, state.selector);
      }),
      contains: roots.flatMap((other, otherIndex) => root !== null && other !== null && otherIndex !== index
        && root.contains(other)
        ? [otherIndex]
        : []),
    };
  });
}

/** The question the page is asked about `entry`. */
function probeOf(entry: ComponentEntry): SelectorProbe {
  return {
    selector: entry.selector,
    examples: entry.examples,
    states: entry.states.map((state) => (state.mode === 'example'
      ? { mode: state.mode, selector: state.selector }
      : { mode: state.mode, selector: state.target })),
  };
}

/** How a count reads in a detail. */
function matchesText(count: number | null): string {
  return count === null
    ? 'is not a valid selector'
    : `matches ${count} element${count === 1
      ? ''
      : 's'}`;
}

/** Step 4: the root selector matches exactly one element. */
function selectorReasons(entry: ComponentEntry, reading: SelectorReading): readonly RejectionReason[] {
  const count = reading.selectorCount;

  if (count === 1) {
    return [];
  }

  const detail = `selector "${entry.selector}" ${matchesText(count)} on ${entry.page}, not exactly one`;

  return [reason(count !== null && count > 1
    ? 'selector-multi-match'
    : 'selector-no-match', detail)];
}

/** Step 5: every example matches at least one element. */
function exampleReasons(entry: ComponentEntry, reading: SelectorReading): readonly RejectionReason[] {
  return entry.examples.flatMap((example, index) => {
    const count = reading.exampleCounts[index] ?? null;

    return count !== null && count > 0
      ? []
      : [reason('example-no-match', `example "${example}" ${matchesText(count)} on ${entry.page}`)];
  });
}

/** Step 6: every example state matches, every action target resolves once inside the component. */
function stateReasons(entry: ComponentEntry, reading: SelectorReading): readonly RejectionReason[] {
  return entry.states.flatMap((state, index) => {
    const count = reading.stateCounts[index] ?? null;

    if (state.mode === 'example') {
      return count !== null && count > 0
        ? []
        : [reason('state-unresolved', `state "${state.name}" example "${state.selector}" ${matchesText(count)} on ${entry.page}`)];
    }

    return count === 1
      ? []
      : [reason(
        'state-unresolved',
        `state "${state.name}" ${state.action} target "${state.target}" ${matchesText(count)} inside "${entry.selector}", not exactly one`,
      )];
  });
}

/** Steps 4 to 6 for one entry: the reasons of the first step it fails, or none. */
function firstFailingStep(entry: ComponentEntry, reading: SelectorReading): readonly RejectionReason[] {
  const steps = [selectorReasons, exampleReasons, stateReasons];

  return steps.reduce<readonly RejectionReason[]>(
    (found, step) => (found.length > 0
      ? found
      : step(entry, reading)),
    [],
  );
}

/**
 * Steps 4 to 7 for the entries of one page, from its readings: each
 * entry's reasons, empty when it is accepted.
 */
function judgePage(
  entries: readonly ComponentEntry[],
  readings: readonly SelectorReading[],
): readonly (readonly RejectionReason[])[] {
  const stepReasons = entries.map((entry, index) => {
    const reading = readings[index];

    if (reading === undefined) {
      throw new Error(`no selector reading for ${entry.name} on ${entry.page}`);
    }

    return firstFailingStep(entry, reading);
  });

  return entries.map((entry, index) => {
    const own = stepReasons[index] ?? [];

    if (own.length > 0) {
      return own;
    }

    return (readings[index]?.contains ?? []).flatMap((containedIndex) => {
      const contained = entries[containedIndex];

      return contained === undefined
        || (stepReasons[containedIndex] ?? []).length > 0
        || levelRank(contained.level) < levelRank(entry.level)
        ? []
        : [reason(
          'contains-equal-or-higher',
          `${entry.level} "${entry.selector}" contains ${contained.name}, a ${contained.level} at "${contained.selector}"`,
        )];
    });
  });
}

/** Steps 4 to 7 for the entries naming `pagePath`, in one load of the page. */
function validatePage(
  browser: Browser,
  address: string,
  pagePath: string,
  entries: readonly ComponentEntry[],
): Promise<readonly (readonly RejectionReason[])[]> {
  return withSeedPage(browser, address, pagePath, async (page) => {
    const readings = await page.evaluate(readSelectorsInPage, entries.map(probeOf));

    return judgePage(entries, readings);
  });
}

/**
 * Validates `candidates`, from any path, against the pages served at
 * `address`, in the order the module documentation lists.
 *
 * @param browser - A launched Chromium browser.
 * @param address - The running server's base URL, such as `http://127.0.0.1:4600/`.
 * @param keptPages - The kept page paths, as `keptPages` in `pipeline/serve/check.ts` returns them.
 * @param candidates - Proposed entries, origin stamped, as any value: the shape is the first check.
 * @returns The accepted entries and the rejected candidates, each in input order.
 * @throws Error when a named kept page does not load or settle, as `withSeedPage`.
 */
export async function validateCandidates(
  browser: Browser,
  address: string,
  keptPages: readonly string[],
  candidates: readonly unknown[],
): Promise<ValidationResult> {
  const outcomes = checkStatically(keptPages, candidates);
  const pending = outcomes.flatMap((outcome) => (outcome.kind === 'pending'
    ? [outcome.entry]
    : []));
  const pages = [...new Set(pending.map((entry) => entry.page))].sort();
  const judged = await Promise.all(pages.map(async (pagePath) => {
    const entries = pending.filter((entry) => entry.page === pagePath);
    const reasons = await validatePage(browser, address, pagePath, entries);

    return entries.map((entry, index) => [entry, reasons[index] ?? []] as const);
  }));
  const reasonsByEntry = new Map(judged.flat());
  const results = outcomes.map((outcome, index) => ({
    candidate: candidates[index],
    entry: outcome.kind === 'pending'
      ? outcome.entry
      : undefined,
    reasons: outcome.kind === 'pending'
      ? reasonsByEntry.get(outcome.entry) ?? []
      : outcome.reasons,
  }));

  return {
    accepted: results.flatMap((result) => (result.entry !== undefined && result.reasons.length === 0
      ? [result.entry]
      : [])),
    rejected: results.flatMap((result) => (result.reasons.length > 0
      ? [{ candidate: asJson(result.candidate), reasons: result.reasons }]
      : [])),
  };
}
