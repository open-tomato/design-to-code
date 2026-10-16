# design-to-code

Extracts a React component library from a design export.

## First Run

```sh
bun install
bun run setup
bun run test
```

`bun run setup` installs Chromium through the pinned `playwright` package: the
`storybook` test project launches Chromium through Playwright, so `bun run test`
fails at browser launch until it has run.

## Tool Root Layout

The repository is organized as follows:

- **`bin/`** — The CLI entry point (`d2c.ts`), run via `bun run d2c
  <verb>`.
- **`config/`** — The project config schema (`schema.ts`), loader
  (`load.ts`) and page-choice writer (`save.ts`). Validates each
  project's configuration and fills in defaults; the writer records
  curation choices in `pages.keep` / `pages.discard`.
- **`templates/library/`** — The seed of every new library package. Each
  extraction copies this template, its `package.json`, `tsconfig.json`,
  `eslint.config.mjs` (the root config plus `cva-only-classname` and the
  `react-hooks` rules as errors), `src/lib/cn.ts` (class-name utilities), a
  CVA re-export, and a style entry point.
- **`harness/`** — The shared Storybook instance, generic over the project
  config. The `harness/.storybook/` directory holds the Storybook
  configuration (`main.ts`, `preview.ts`); the `fixtures/` subdirectory
  contains fixture stories.
- **`projects/`** — Per-project extraction configs. Each is a
  `<slug>.json` file; only `projects/example.json` is tracked. The active
  project is determined by the `D2C_PROJECT` environment variable.
- **`pipeline/import/`** — Folder and zip import with hashed records.
- **`pipeline/assess/`** — Deterministic discovery and agent-notes merging.
- **`pipeline/baseline/`** — Visual regression baseline capture and
  confirmation.
- **`pipeline/serve/`** — HTTP server over design exports with injected
  navigation bar and curation endpoints.
- **`pipeline/seed/`** — Component manifest building from markers,
  design-system manifests, or agent proposals.
- **`pipeline/gates/`** — Local gates for structure, state coverage,
  build-lint, and story-health.
- **`prompts/`** — Agent prompts; `assess.md` is the prompt for analyzing
  design exports.

Files and directories ignored on purpose:

- **`design/`, `components/`, `baselines/`** — Design exports and
  extraction outputs; heavy assets not tracked.
- **`docs/`** — Local notes (not tracked).
- **`projects/*.json`** — Per-project configs, except the example.

## Project Configuration

Each project is configured by a JSON file in `projects/<slug>.json`, where
`<slug>` is the project identifier. The configuration is validated against
a schema and defaults are filled in automatically.

### Configuration Fields

All fields below are at the top level of the config object. Fields marked
**required** must be present; others are optional or have defaults.

#### `slug` (required)

The project identifier. Must be lowercase ASCII letters and digits in
hyphen-separated runs (e.g., `homepage`, `my-project`). Used to name the
config file and seed default paths.

#### `name`

Human-readable project name. Defaults to the `slug` if not provided.

#### `source` (required)

Object describing the design export source.

- **`source.dir`** (required) — Path to the design export directory,
  relative to the repo root. The loader checks that this path exists and is
  a directory.
- **`source.shareLink`** — Optional URL the design export was shared from.
  When set, enables automatic share-link comparison during `baseline confirm`
  to validate captured pages against the design's public share link.

#### `target`

Object describing where the extracted library is placed.

- **`target.dir`** — Directory for the extracted library, relative to the
  repo root. Defaults to `components/<slug>`.
- **`target.kind`** — Type of package. Currently only
  `component-library` is supported (the default).

#### `baselineDir`

Directory for storing visual regression baselines, relative to the repo
root. Defaults to `baselines/<slug>`.

#### `storybook`

Object describing the Storybook setup.

- **`storybook.mode`** — How the library uses Storybook. Options are
  `managed` (uses the shared harness, the default) or `detached` (the
  library ships its own Storybook). The `detached` mode is part of the
  schema but is not supported yet; the loader will refuse it with a
  "not supported yet" error.

#### `levels`

Optional list of the component library's level folder names, lowest level
first. A component lives in `<target.dir>/src/<level>/<Name>/`. The list
must be non-empty and must not repeat a name. Defaults to `particles`,
`atoms`, `molecules`, `organisms`, `templates`, `layouts`.

#### `pages`

Object for filtering which design pages to include or exclude. Page-path
values match the `path` field of page entries in `discovery.json`
(e.g., `Rafa Portal v2.dc.html`, `screens/app/dashboard.html`).

- **`pages.keep`** — Optional list of page paths to include. If provided,
  only these pages are processed.
- **`pages.discard`** — Optional list of page paths to exclude. A page in
  `discard` is excluded; a page in `keep` or in neither list is included.

#### `viewports`

Optional list of viewport sizes to test. Each viewport is an object with:

- **`name`** — Identifier for the viewport (e.g., `mobile`, `tablet`).
- **`width`** — Width in pixels (positive integer).
- **`height`** — Height in pixels (positive integer).

Required by `baseline capture` to specify which viewport sizes to capture and
test for visual consistency.

#### `tolerance`

Object for customizing tolerance thresholds.

- **`tolerance.designVsCode`** — Optional share of differing pixels
  allowed between the design and the generated code, from 0 to 1. Used for
  visual regression testing.

## bun run d2c config

The `config` verb loads the active project's configuration and prints it as
JSON with all defaults filled in. This is useful for verifying your setup
or understanding what defaults are applied.

### Usage

```bash
D2C_PROJECT=my-project bun run d2c config
```

The `D2C_PROJECT` environment variable must be set to the project slug.
The loader will read `projects/<slug>.json` and print the parsed config
to stdout, or an error message to stderr if validation fails.

### Examples

#### Error: Empty config

An empty config object will fail because `slug` and `source.dir` are
required:

```json
{}
```

Error output:

```text
d2c config: projects/example.json: invalid project config
  slug: Required
  source.dir: Required
```

#### Minimal valid config

The simplest working configuration provides only the required fields:

```json
{
  "slug": "homepage",
  "source": {
    "dir": "design/homepage"
  }
}
```

Running `bun run d2c config` with this configuration prints:

```json
{
  "slug": "homepage",
  "name": "homepage",
  "source": {
    "dir": "design/homepage"
  },
  "target": {
    "dir": "components/homepage",
    "kind": "component-library"
  },
  "baselineDir": "baselines/homepage",
  "storybook": {
    "mode": "managed"
  }
}
```

Note how `name`, `target.dir`, `baselineDir`, and the full `storybook`
object are filled in with defaults.

#### Config with optional fields

A more complete configuration might include optional fields for filtering
pages and setting custom viewports:

```json
{
  "slug": "homepage",
  "name": "Homepage Components",
  "source": {
    "dir": "design/homepage",
    "shareLink": "https://figma.com/file/..."
  },
  "target": {
    "dir": "libs/homepage-ui"
  },
  "pages": {
    "discard": ["Archive", "WIP"]
  },
  "viewports": [
    { "name": "mobile", "width": 375, "height": 667 },
    { "name": "tablet", "width": 768, "height": 1024 }
  ],
  "tolerance": {
    "designVsCode": 0.05
  }
}
```

When loaded, defaults fill in any omitted fields (e.g., `baselineDir`,
`storybook.mode`).

#### Unsupported: detached Storybook mode

The `detached` Storybook mode is defined in the schema but not yet
supported. Attempting to use it:

```json
{
  "slug": "my-project",
  "source": { "dir": "design/my-project" },
  "storybook": { "mode": "detached" }
}
```

Results in an error:

```text
d2c config: projects/my-project.json: storybook.mode: 'detached'
is not supported yet; use 'managed'
```

## Exit codes

Every verb exits with one of three codes:

- **0** — The verb succeeded.
- **1** — The verb refused: a usage error, a bad project config, or an
  import, assess, serve, baseline, seed or gates refusal such as a non-empty
  `source.dir`, a zip with a case collision, a missing `discovery.json`, a
  missing import record, or a missing `target.dir`. The reason is
  printed on stderr as `d2c <verb>: <message>` or `d2c: <message>`, with
  no stack trace.
- **2** — An unexpected failure, such as a bug or an I/O error. The error's
  stack trace is printed on stderr.

`serve --check` also exits 1 when a page has a problem, `baseline confirm`
when a kept page is left unconfirmed, `baseline capture` when a capture
is flaky, and `gates` when a gate fails.

## Import and assess

The workflow imports a design export and discovers its structure: pages,
scripts, stylesheets, assets, and recognized token or variant files.

### Use case

A designer downloads the export zip from Claude Design, sets `D2C_PROJECT`,
then runs:

```bash
D2C_PROJECT=my-project bun run d2c import --source=export.zip
D2C_PROJECT=my-project bun run d2c assess
```

The `assess` step prints a discovery report listing every entry page, script,
token file, and asset group found, with known files marked found or absent.

### The `import` verb

Copies a design export — a folder or a `.zip` file — into the project's
`source.dir` and writes an import record.

#### Syntax

```bash
D2C_PROJECT=<slug> bun run d2c import --source=<path> [--force]
```

#### Options

- **`--source=<path>`** (required) — A folder or a `.zip` file. Relative
  paths resolve against the working directory.
- **`--force`** — Empty a non-empty `source.dir` before importing. Without
  this flag, a non-empty target directory refuses the import.

#### The import record

The import writes `<source.dir>/.import/record.json`, a JSON file that
records:

- **`kind`** — `"folder"` or `"zip"`, identifying the source type.
- **`originalPath`** — The `--source` as given on the command line.
- **`importedAt`** — An ISO 8601 date-time of the import.
- **`files`** — One entry per regular file copied, each holding:
  - **`path`** — POSIX-relative path to the file in `source.dir`.
  - **`sha256`** — The file's SHA-256 digest as lowercase hex.
- **`dropped`** — One entry per zip entry left out on purpose, each holding:
  - **`path`** — The entry name as the zip holds it, before any unwrapping.
  - **`reason`** — `"macos-metadata"` for an entry under a top-level
    `__MACOSX/` folder, or `"ds-store"` for a `.DS_Store` file at any depth.

Files and dropped entries are listed sorted by path, with `.import/` omitted
so the record does not hash itself. Every import replaces the record; none is
required. A folder import records `dropped: []`, and a record written before
`dropped` existed reads as having dropped nothing.

A zip made by macOS Finder's "Compress" holds a top-level `__MACOSX/` folder
and `.DS_Store` files beside the export. These are dropped before the zip's
lone top-level folder is unwrapped, so a Finder zip of one folder lands at the
root of `source.dir`. A `__MACOSX/` folder below the top level is kept.

#### Edge cases

- An export with no `_ds/` folder still gets a full page list; the markers
  tool looks for any `data-*` attribute.
- A single-page export gives a one-page report in the same format.
- A second import without `--force` refuses with a clear message.
- Two paths that differ only in case, such as `a.html` beside `A.html`,
  or folders such as `Pages/a.html` beside `pages/b.html`, refuse the whole
  import before anything is written. The message names both spellings. A
  case-insensitive file system (the macOS and Windows default) holds only
  one of them. The check compares whole paths with extensions, so
  `Button.tsx` beside `button.css` imports.

### The `assess` verb

Runs discovery scripts to find all pages, scripts, stylesheets, assets, and
recognized token or variant files. Optionally then runs the assess agent to
add semantic notes.

#### Syntax

```bash
D2C_PROJECT=<slug> bun run d2c assess [--scripts-only]
```

#### Options

- **`--scripts-only`** — Write the discovery report and exit; skip the
  assess agent step. Useful for quick inspection or working offline.

#### Discovery and the `discovery.json` report

The scripts write `<source.dir>/discovery.json` containing:

- **`generatedAt`** — An ISO 8601 date-time of the discovery run (the only
  field allowed to differ between two runs over the same export).
- **`pages`** — Every `.html` file found, sorted by path. Each page holds:
  - **`path`** — POSIX-relative path to the file.
  - **`title`** — The page's `<title>`, or `null` if absent.
  - **`scripts`** — Every script tag, by `src` or `inline`.
  - **`stylesheets`** — Every stylesheet, by `href` or `inline`.
  - **`markers`** — Counts of each `data-*` attribute name, keys sorted.
- **`tokens`** — `tokens.*` files and CSS files declaring custom
  properties, sorted by path. Each holds:
  - **`path`** — File path.
  - **`customPropertyCount`** — Number of CSS custom properties declared.
- **`variantMaps`** — `variants.*` files found, sorted by path.
- **`assets`** — All remaining files grouped by kind:
  - **`images`**, **`fonts`**, **`styles`**, **`scripts`**, **`other`** —
    Sorted lists of file paths in each group.
- **`knownFiles`** — Status of recognized files:
  - **`_adherence.oxlintrc.json`** — Oxlint config (if present).
  - **`_ds_manifest.json`** — Claude Design manifest (if present).
  - **`support.js`** — Support script (if present).
  - **`tokens.ts`** — TypeScript tokens (if present).
  - **`variants.ts`** — TypeScript variants (if present).

Each known file entry holds:
  - **`name`** — The file name.
  - **`status`** — `"found"` or `"absent"`.
  - **`paths`** — List of paths where the file was found; empty if absent.

None of the known files are required; `discover` reports what was found.

#### With the assess agent

Without `--scripts-only`, `bun run d2c assess` runs the assess agent with
`claude -p`, with no tools (see [Trust and safety](#trust-and-safety)), to
add semantic notes to the report. The agent identifies:

- **Page roles** — Whether each page is an early version, demo, breakdown,
  or other.
- **Version groups** — Sets of pages that are versions of the same
  component.
- **Component boundary hints** — Locations where component boundaries are
  marked (by CSS selector or `data-*` attribute).

The final report is written again with the agent's notes merged in.

## Serve and curate

The workflow serves the discovered design pages behind an injected navigation
bar, allowing side-by-side comparison of versions and curation of the pages to
process.

### Use case

After assessing the export, the user opens the printed server address in a
browser, collapses the injected navigation bar, and compares versions of the
same component—for example, `Rafa Portal` and `Rafa Portal v2`. They use the
**Keep** and **Discard** buttons in the navigation bar to record their choice
directly in the project config, discarding obsolete or unwanted pages.

### The `serve` verb

Starts a local HTTP server over the project's design export, with an injected
navigation bar listing every discovered page and endpoints for page curation.

#### Syntax

```bash
D2C_PROJECT=<slug> bun run d2c serve [--check]
```

#### Options

- **`--check`** — Start the server, load every kept page in a headless browser
  with the navigation bar suppressed (`?d2c-nav=0`), write a report of any
  console errors, failed requests or blank renders to `serve-check.json`, stop
  the server, then exit 0 when every page loaded cleanly or exit 1 when any
  page has a console error, a failed request or a blank render. The report
  is written either way.

#### Environment variables

- **`D2C_PORT`** — If set, must be an integer from 1 to 65535. The server
  binds to that port or exits with an error if the port is in use. If unset,
  the server tries port 4600 upward, taking the first available port up to
  4699.

#### Prerequisites

The server requires `<source.dir>/discovery.json`, written by `bun run d2c
assess --scripts-only`. Serve refuses to start without it.

#### Output files

The server writes two files to `<source.dir>`:

- **`.serve.json`** — A snapshot of the current project config and server
  state when `serve` starts. Updated by curation.
- **`serve-check.json`** — Written by `--check`, contains a report of each
  kept page: its path, any console errors, any failed requests, and whether
  it rendered non-blank.

#### Navigation bar query parameter

- **`?d2c-nav=0`** — Suppresses the injected navigation bar. Used by `--check`
  to keep the nav bar out of baseline captures.

#### Page curation

The navigation bar displays every discovered page with **Keep** and **Discard**
buttons. Clicking either button:

1. Writes the page's path to `pages.keep` or `pages.discard` in the active
   project config.
2. Moves the page out of the other list (a page is in at most one list).
3. Updates `.serve.json` to reflect the new state.

Kept pages (those in `pages.keep` or in neither list) are processed in later
stages; discarded pages are skipped.

#### Reserved paths

Paths under `/__d2c/` are reserved for the tool and never read from disk:

- **`/__d2c/pages`** — Returns the current page list as JSON.
- **`/__d2c/keep?path=<page-path>`** — Moves a page to the keep list.
- **`/__d2c/discard?path=<page-path>`** — Moves a page to the discard list.

#### Edge cases

- A page that renders blank due to out-of-order scripts is reported by
  `--check` (in `serve-check.json`) but not fixed by the server. The export
  is the baseline; the server never rewrites files to make them work. Bring the
  issue to the designer.
- The server binds only to `127.0.0.1`, not to all network interfaces.

## Confirm and capture a baseline

The workflow validates the served design pages and captures them as visual
baselines for regression testing. In short: *the demo is the spec, the
baseline is the test*. A baseline is only written for a page
that a person (or the share-link comparison) has confirmed, and only when two
fresh captures of it agree pixel for pixel.

### Use case

After curating pages with `serve`, the user has a private design share link and
runs:

```bash
D2C_PROJECT=my-project bun run d2c baseline confirm
```

For each kept page, the command opens it in a headed browser with the nav bar
off, displays its `serve --check` findings (console errors, failed requests,
blank flag), and asks `Does <page> work as in Claude Design? [y/N]`. Typing
`y` confirms the page; anything else leaves it unconfirmed. The command starts
the server and stops it when done.

Alternatively, with `source.shareLink` configured, the command attempts
automatic validation: it loads each page through the share link's Claude Design
view, extracts the design frame from the view, and compares it with the served
page at the same viewport size. If the share of differing pixels is under the
confirmation threshold (1%), the page is confirmed automatically with the
`share-link` method and a pixel-difference score recorded. Pages that exceed
the threshold, lack a design frame, or cannot reach the share link fall back to
person confirmation.

Once all kept pages are confirmed (or the user exits), capture runs:

```bash
D2C_PROJECT=my-project bun run d2c baseline capture
```

Capture requires `viewports` to be configured. For each kept, confirmed page
and each configured viewport, it performs a double capture: two fresh Chromium
contexts, each loading the page through `serve --check` settings (nav bar off),
with identical capture settings to ensure pixel-perfect consistency. If both
captures match exactly, the screenshots are stored; if any pixel differs, the
page-viewport pair is marked flaky with a bounding box around every differing
pixel and no screenshot is captured for it.

### The `baseline confirm` verb

Confirms that design pages render correctly by comparing them either to a
private share link (if configured) or through person review.

#### Syntax

```bash
D2C_PROJECT=<slug> bun run d2c baseline confirm
```

#### Prerequisites

- Import has run (`<source.dir>/.import/record.json` exists).
- Assessment has run (`<source.dir>/discovery.json` exists).
- Curation has run (kept pages are recorded in the project config).

#### Output files

The command writes `<baselineDir>/confirmed.json` with an entry per kept page:

```json
{
  "pages": {
    "index.html": {
      "page": "index.html",
      "confirmedAt": "2024-09-30T14:32:00.000Z",
      "by": "person",
      "importHash": "abc123...",
      "score": null
    },
    "about.html": {
      "page": "about.html",
      "confirmedAt": "2024-09-30T14:35:00.000Z",
      "by": "share-link",
      "importHash": "abc123...",
      "score": 0.0042
    }
  }
}
```

Each page entry holds:

- **`page`** — The page path from the discovery report.
- **`confirmedAt`** — ISO 8601 timestamp of confirmation.
- **`by`** — Either `"person"` (manual confirmation) or `"share-link"`
  (automatic validation via the design's public link).
- **`importHash`** — SHA-256 hex digest of the import record as it was at the
  time of confirmation. Capture will only use a confirmed page if its
  `importHash` matches the current import's hash; a re-import requires a new
  confirmation.
- **`score`** — Pixel-difference share (0 to 1) for share-link confirmations;
  `null` for person confirmations.

#### Share-link comparison

If `source.shareLink` is configured, `baseline confirm` attempts automatic
validation for each page. The share link is considered public if an
unauthenticated browser load answers with a 2xx status and does not redirect to
a different origin. For each page, the command loads the design view at the
share link and extracts the largest visible design frame (`<iframe>`). It then
compares that frame's content with the served page at a matching viewport size,
recording the share of differing pixels. If the share is under the confirmation
threshold (1%), the page is confirmed automatically with a `share-link` method
and its score recorded.

Pages that exceed the threshold, lack a design frame, or cannot reach the share
link fall back to person confirmation.

#### Person confirmation

For pages not automatically confirmed (or for every page if `source.shareLink`
is not set), the command displays the page path and its `serve --check`
findings, then opens a headed Chromium window with the navigation bar
suppressed (`?d2c-nav=0`). It waits for `networkidle` and prompts:

```text
Does <page> work as in Claude Design? [y/N]
```

Typing `y` records the confirmation; any other input (including `N` or Enter)
leaves the page unconfirmed and moves to the next one. Tests inject the page
opener and prompter; the CLI's defaults are a headed browser and readline
stdin.

#### Exit code

- **0** — All kept pages are confirmed.
- **1** — One or more kept pages are left unconfirmed (the user chose not to
  confirm them, or share-link validation failed for all and the prompt was
  skipped). The names of unconfirmed pages are printed to stderr.

### The `baseline capture` verb

Captures visual baselines for confirmed pages under controlled settings,
detecting flaky regions that differ across two independent capture runs.

#### Syntax

```bash
D2C_PROJECT=<slug> bun run d2c baseline capture
```

#### Prerequisites

- `viewports` must be configured in the project config.
- Each kept page must have a current confirmation in `confirmed.json` whose
  `importHash` matches the current import.

#### Capture settings

Each page is loaded once per viewport in a fresh Chromium context with:

- **Viewport:** The configured viewport size (`width`, `height`).
- **Device scale factor:** 1 (pixel-perfect rendering).
- **Locale:** `en-US` (consistent text layout).
- **Timezone:** `UTC` (deterministic date/time display).
- **Clock:** A fixed, named epoch installed before navigation (seeded for
  reproducibility across runs).
- **Random number generator:** An init script replaces `Math.random` with a
  seeded PRNG to ensure deterministic behavior.

The page is loaded through the server with the navigation bar suppressed
(`?d2c-nav=0`), then the browser waits for `networkidle`, font loading
(`document.fonts.ready`), scrolls to the bottom and back to the top to trigger
lazy-loaded images and icons, and waits for `networkidle` again. A full-page
screenshot is then taken with animations left running (`animations: 'allow'`)
to capture motion. Motion is not disabled.

#### Double capture and flaky detection

Each page-viewport combination is captured twice in independent, fresh Chromium
contexts using the same capture settings. The two screenshots are compared
pixel-by-pixel using `pixelmatch`. If every pixel matches, both screenshots are
stored; if any pixel differs (including dimension mismatches, which are
considered a full difference over the larger image), the page-viewport pair is
marked **flaky**.

Flaky pages are recorded in `capture.json` with a bounding box enclosing every
differing pixel, allowing future visualization of the flaky region. No PNG is
written for flaky page-viewport combinations until the variability is fixed
(e.g., a live clock or random animation needs to be made deterministic in the
demo).

#### Storage layout

Baselines are stored under `<baselineDir>/<playwright-version>/<import-hash>/`,
where:

- **`<baselineDir>`** — The configured baseline directory (defaults to
  `baselines/<slug>`, resolved relative to the repo root).
- **`<playwright-version>`** — The semantic version of the installed
  `playwright-core` package (e.g., `1.40.1`).
- **`<import-hash>`** — SHA-256 hex digest of the bytes of
  `<source.dir>/.import/record.json` as it was written at import time. This
  ensures that re-importing the design (which updates `importedAt`) generates a
  new storage key, keeping old and new captures separate.

Under this directory:

- **`pages/<page-path>/<viewport-name>.png`** — Screenshot for each captured
  page and viewport (e.g., `pages/index.html/mobile.png`).
- **`capture.json`** — Metadata and flaky region records.
- **`animations.json`** — Animation inventory (see below).

Every write is validated with a containment check to ensure files cannot escape
the storage directory.

#### `capture.json`

The capture metadata file records:

```json
{
  "generatedAt": "2024-09-30T14:40:00.000Z",
  "playwrightVersion": "1.40.1",
  "importHash": "abc123...",
  "pages": {
    "index.html": {
      "mobile": {
        "captured": {
          "file": "pages/index.html/mobile.png"
        }
      },
      "tablet": {
        "flaky": {
          "differingPixels": 42,
          "region": { "x": 100, "y": 200, "width": 50, "height": 30 }
        }
      }
    }
  }
}
```

Fields:

- **`generatedAt`** — ISO 8601 timestamp of the capture run.
- **`playwrightVersion`** — Playwright version used for capture (to
  distinguish baselines across Playwright upgrades).
- **`importHash`** — SHA-256 hex of the import record, matching the storage
  directory's import hash.
- **`pages`** — Per-page entries, keyed by page path.
  - **Per-viewport entries:**
    - **`captured`** — Present if both captures matched: holds
      `{ file: "<relative-path-to-png>" }`.
    - **`flaky`** — Present if the two captures differed: holds
      `{ differingPixels: <count>, region: { x, y, width, height } }`, where
      the region is the minimal bounding box enclosing every differing pixel.

#### `animations.json`

The animation inventory is read once per page at the first configured viewport,
captured within the first capture context immediately after the load waits
complete. It records all running animations at that moment:

```json
{
  "pages": {
    "index.html": {
      "animations": [
        {
          "kind": "CSSAnimation",
          "animationName": "spin",
          "selector": ".icon",
          "timing": {
            "duration": 2000,
            "delay": 0,
            "easing": "linear",
            "iterations": "Infinity",
            "direction": "normal",
            "fill": "auto"
          },
          "keyframes": [...]
        },
        {
          "kind": "CSSTransition",
          "transitionProperty": "opacity",
          "selector": ".modal",
          "timing": {...},
          "keyframes": [...]
        }
      ]
    }
  }
}
```

For each animation:

- **`kind`** — `"CSSAnimation"`, `"CSSTransition"`, or `"Other"`.
- **`animationName`** or **`transitionProperty`** — The animation or transition
  identifier.
- **`selector`** — CSS selector path to the animated element.
- **`timing`** — From `effect.getTiming()`: duration, delay, easing,
  iterations, direction, fill.
- **`keyframes`** — From `effect.getKeyframes()`: array of keyframe definitions.

#### Exit code

- **0** — All kept, confirmed pages captured successfully (no flaky
  page-viewport combinations). The baseline is ready for testing.
- **1** — One or more page-viewport combinations are flaky. The command still
  writes `capture.json` and `animations.json` with the flaky records, but no
  baselines are accepted yet. Flaky pages and their regions are printed to
  stderr. Fix the source of variability in the demo (e.g., a live clock, a
  randomized animation) and run capture again.
- **2** — A non-flaky failure (e.g., missing `viewports`, unconfirmed pages, I/O
  error). The command refuses to run; the reason is printed to stderr.

## Seed the component manifest

The workflow builds a manifest of the components to extract, each with its
location on a design page, its visual states, its variant axes, and
documentation text. When an export marks its components with data attributes,
`bun run d2c seed` builds the manifest directly from those markers; when it
does not, the agent proposes candidates and `seed` validates each one against
the served page, so no invented selector reaches the extraction loop.

### Use case

An export made with the breakdown prompt carries component markers, and seed
needs no agent session at all. An older export without markers goes through
the agent path, which costs one Claude session; the seed verb runs the agent
and validates every candidate before accepting it.

### The `seed` verb

Seeds the active project's component manifest by reading markers or a
design-system manifest from kept pages (the script path), running the agent on
unmarked pages (the agent path), and validating every candidate against the
served pages before writing the manifest.

#### Syntax

```bash
D2C_PROJECT=<slug> bun run d2c seed
```

#### Prerequisites

- Assessment has run (`<source.dir>/discovery.json` exists).
- Curation has run (kept pages are recorded in the project config).

#### Marker convention

Component markers are `data-*` attributes on HTML elements. The markers you
can use are:

| Marker | Purpose |
|--------|---------|
| `data-component="<Name>"` | Root element of a component |
| `data-level="<level>"` | Component level (see levels table below) |
| `data-part="<name>"` | Named structural part of a component |
| `data-state="<name>"` | Marks a root showing a specific visual state statically |
| `data-variant-<axis>="<value>"` | Variant value on an axis (e.g., `data-variant-size="large"`) |
| `data-doc="<Name>"` | Element whose text is documentation for that component |

Levels are `particle`, `atom`, `molecule`, `organism`, `template`, and
`layout`, from smallest to largest. A component's level determines what it can
contain: a particle contains nothing; an atom may contain particles; a
molecule may contain atoms and particles; an organism may contain molecules,
atoms, and particles; a template may contain organisms and smaller; a layout
may contain templates and smaller.

On each kept page, the first root marked `data-component="<Name>"` without a
`data-state` attribute becomes the component's main `selector`; other roots
with the same name on that page become visual `examples`, and each root with a
`data-state` attribute becomes a static example state.

#### Design-system manifest

A filled `_ds_manifest.json` file in the design export's `_ds/` folder
enriches or provides components when markers are absent or incomplete. Each
entry needs a `name`; optional fields are `level`, `description` (becomes
documentation text), `variants` (axis name to a list of values), `page` and
`selector`. An entry with both `page` and `selector` is used as written; one
without is located by searching for `data-component="<name>"` on kept pages;
one located nowhere is rejected as `unlocated`. Design-system manifest entries
carry `origin: 'manifest'`, overriding marker-based fields where both exist.

#### Agent path

When a kept page holds no `data-component` markers and no filled
design-system manifest covers its components, the agent path runs once per
seed run. The seed verb builds a compact DOM outline per unmarked kept page
(tag, id, classes, `data-*` attributes, element text sample, and depth),
passes every outline and discovery notes to the agent prompt
`prompts/seed.md`, and receives one JSON object containing an array of
proposed component candidates.

The agent runs only when at least one kept page is unmarked by both paths;
a fully marked export triggers no agent session.

#### Validation checks

Every candidate (from markers, the design-system manifest, or the agent) is
validated against the served page in this order:

1. **Shape**: Validates against the candidate schema. Candidates that fail are
   rejected as `invalid-shape`.
2. **Uniqueness**: Checks that no two accepted candidates share the same name.
   Duplicates are rejected as `duplicate-name`.
3. **Kept page**: Verifies the `page` is a kept (not discarded) page.
   Candidates on discarded pages are rejected as `page-not-kept`.
4. **Selector match**: Checks that the `selector` matches exactly one element
   on the `page`. Candidates with no match are rejected as `selector-no-match`;
   those with multiple matches are rejected as `selector-multi-match`.
5. **Examples**: Verifies each selector in `examples` matches at least one
   element. Examples that match nothing are rejected as `example-no-match`.
6. **States**: Validates each state: example states' `selector` must match
   exactly one element; action states' `target` must match exactly one element
   inside the component. States that fail are rejected as `state-unresolved`.
7. **Containment**: Checks that the component's element does not contain any
   other accepted candidate's element of equal or higher level on the same
   page. Violations are rejected as `contains-equal-or-higher`, naming the
   contained candidate.

A candidate collects every reason that applies when it fails validation; all
reasons are recorded in `seed-rejected.json`.

#### Rejection codes

All rejection codes for `seed-rejected.json`:

- **`invalid-shape`** — Candidate fails the schema (unknown field, wrong type,
  missing required field, etc.).
- **`duplicate-name`** — Another accepted candidate already uses this name.
- **`page-not-kept`** — The `page` is not a kept page.
- **`selector-no-match`** — The main `selector` matches no element on `page`.
- **`selector-multi-match`** — The main `selector` matches more than one
  element on `page`.
- **`example-no-match`** — One or more entries in `examples` match no element
  on `page`.
- **`contains-equal-or-higher`** — The component contains another accepted
  candidate of equal or higher level on the same page.
- **`state-unresolved`** — One or more states fail: an example state's
  `selector` does not match exactly one element, or an action state's `target`
  does not match exactly one element inside the component.
- **`missing-level`** — No `level` is provided (from marker, manifest, or
  validation assumptions). Rejected candidates from markers or the agent; a
  design-system manifest entry without a level is resolved by searching kept
  pages.
- **`unlocated`** — A design-system manifest entry with `page` and `selector`
  omitted matches no `data-component` root on any kept page.

#### Output files

The seed run writes two files to `<source.dir>`:

##### `seed-manifest.json`

Contains all accepted components, in extraction order (by level, then page
path, then name). Each component includes:

- `name` — Unique identifier across the manifest.
- `level` — One of the atomic levels.
- `page` — The kept page path where the component is located.
- `selector` — A CSS selector matching exactly one element (the component
  root).
- `examples` — An array of further selectors showing variants or instances,
  each matching at least one element.
- `states` — An array of visual or interactive states, each with a `name`,
  `mode` (`"example"` for static or `"action"` for interactive), and either
  a `selector` (for example states) or an `action` and `target` (for action
  states).
- `variantAxes` — Object mapping axis names (e.g., `size`, `color`) to sorted
  lists of values. Each axis has at least one value.
- `parts` — Array of named structural parts (e.g., `["icon", "label"]`),
  sorted alphabetically with no duplicates.
- `docText` — Array of documentation strings describing the component,
  in document order.
- `origin` — Where the entry came from: `"markers"` (page data attributes),
  `"manifest"` (design-system manifest), or `"agent"`.

Example `seed-manifest.json`:

```json
{
  "generatedAt": "2024-10-01T14:32:00.000Z",
  "components": [
    {
      "name": "Button",
      "level": "atom",
      "page": "components.html",
      "selector": "#button-primary",
      "examples": ["#button-secondary", "#button-tertiary"],
      "states": [
        {
          "name": "default",
          "mode": "example",
          "selector": "#button-primary"
        },
        {
          "name": "hovered",
          "mode": "action",
          "action": "hover",
          "target": "#button-primary"
        }
      ],
      "variantAxes": {
        "size": ["large", "medium", "small"]
      },
      "parts": ["icon", "label"],
      "docText": ["A reusable button component."],
      "origin": "markers"
    }
  ]
}
```

##### `seed-rejected.json`

Contains all candidates that failed validation, each with the reasons they
were rejected. Structure: `{ generatedAt, rejected }`, where each rejected
candidate is `{ candidate, reasons }` and each reason is `{ code, detail }`.

The `candidate` field holds the proposal exactly as it was submitted (any JSON
shape from the agent, markers, or manifest); known-good candidates use the
shape shown above, but invalid shapes are preserved for debugging.

Example `seed-rejected.json`:

```json
{
  "generatedAt": "2024-10-01T14:32:00.000Z",
  "rejected": [
    {
      "candidate": {
        "name": "Input",
        "level": "atom",
        "page": "forms.html",
        "selector": ".input-multi-match"
      },
      "reasons": [
        {
          "code": "selector-multi-match",
          "detail": "selector matched 3 elements instead of 1"
        }
      ]
    },
    {
      "candidate": {
        "name": "Badge",
        "level": "atom",
        "page": "status.html",
        "selector": ".badge"
      },
      "reasons": [
        {
          "code": "example-no-match",
          "detail": "example selector '.badge.red' matched no elements"
        }
      ]
    }
  ]
}
```

#### Extraction order

Components are ordered by level (lowest to highest), then by page path, then
by name. This places each component after everything it contains on its page,
making the manifest extraction-ready: when extracting a component, all its
dependencies are already in the manifest.

#### Exit codes

- **0** — A manifest with at least one entry was written. Rejections (if any)
  are reported on stdout by count and file, not treated as failures.
- **1** — A refusal: no `discovery.json`, no kept page, no accepted entry at
  all, or the agent failed or returned malformed output. An agent that
  produces no JSON object is an `AgentOutputError` refusal.

## Run the local gates

The gates check an extracted library before anyone reviews it: its
structure, that every seeded state has a story, that it type-checks and
lints, and that every story renders without an error.

### The `gates` verb

Runs the local gates over the active project's library at `target.dir` and
writes one result per gate per component.

#### Syntax

```bash
D2C_PROJECT=<slug> bun run d2c gates --local
```

- **`--local`** — Run the local gates. Required for now: the CI gates
  (state replay, motion replay, token adherence, a11y, layout sanity) are
  not implemented yet, so `gates` without `--local` is a usage error that
  names `--local`.

#### Prerequisites

- `source.dir` exists and holds `seed-manifest.json` (the `seed` verb
  writes it), which the state coverage gate reads.
- `target.dir` exists. An empty `target.dir` is not refused: every gate
  runs and fails with a `scanned-zero-files` finding.

#### Gates

The gates run in this order, each one after the last has finished, and
every gate runs even when an earlier one fails:

1. **`structure`** — Layer imports, shared variants, layout components
   taking children only, and no `pages/` folder.
2. **`state-coverage`** — Every state the seed manifest names for a
   component has a story in `<Name>.stories.tsx`.
3. **`build-lint`** — `tsc --noEmit` over the library and ESLint with the
   library's own config, including the CVA-only className rule.
4. **`story-health`** — Builds the managed Storybook into a temp folder and
   renders every story, failing any that logs an error.

#### Output

Each gate writes `<target.dir>/gate-results/<component>/<gate>.json` for
every component it judged, plus `<target.dir>/gate-results/_library/<gate>.json`
for findings that belong to no component. Before the first gate runs, the
verb deletes the results of components removed from the library: every
`gate-results/<component>/` folder whose component is no longer listed.
A result names its gate,
component, `status` (`pass` or `fail`), its findings (each with a `rule`,
`file`, `line` and `message`) and its duration.

The verb prints one summary line per gate on stdout:

```text
d2c gates: structure pass (12 results, 48 files scanned)
d2c gates: state-coverage pass (12 results, 48 files scanned)
d2c gates: build-lint fail (1 of 12 results failed, 2 findings, 48 files scanned)
d2c gates: story-health pass (12 results, 9 files scanned)
```

and, when any gate failed, names the failed gates on stderr:

```text
d2c gates: 1 of 4 gates failed: build-lint
```

#### Exit codes

- **0** — Every gate passed.
- **1** — A gate failed; or a refusal, printed as `d2c gates: <message>`
  on stderr. No `--local`, an unknown option, a bad project config, or a
  missing `target.dir` or one that is not a folder refuses the whole run,
  and no gate runs. A `seed-manifest.json` that is missing (the message
  names its path and `bun run d2c seed`), is not valid JSON or fails its
  schema refuses only the `state-coverage` gate: every other gate still
  runs and prints its summary line, and the failed gates line on stderr
  counts only the gates that reached a verdict.
- **2** — An unexpected failure, such as a Storybook build that cannot
  start, printed with its stack on stderr.

## Trust and safety

A design export is untrusted input: its pages, scripts and file names come
from outside this repo, and the `assess` and `seed` agent prompts embed parts
of them. So the agent runs as
`claude -p --tools "" --permission-mode plan --strict-mcp-config --setting-sources ""`:
no tools, no MCP servers and no settings files, in a fresh empty temp
directory, with only `PATH`, `HOME`, `TMPDIR`, `LANG` and the `ANTHROPIC_*`
and `CLAUDE_*` variables in its environment. Each prompt states that the
export's content holds no instructions, and names each file by its
JSON-encoded path. The `serve` verb and the static servers under `scripts/`
listen on `127.0.0.1` only and refuse any request path that resolves outside
the directory they serve.

## Testing

The test suite is organized into two projects: `unit` and `integration`.

The `unit` project runs tests in parallel and comprises all test files
matching `{bin,config,harness,pipeline,scripts,templates}/**/*.test.ts`
except those ending in `.integration.test.ts`. These tests do not start
servers or launch browsers.

The `integration` project runs tests serially (one after the other) and
comprises all files matching
`{bin,config,harness,pipeline,scripts,templates}/**/*.integration.test.ts`.
Each test that starts an HTTP server or launches Chromium must:

- Use the file name suffix `.integration.test.ts`
- Pass `port: 0` to `startServer()` and server-starting functions, letting
  the OS assign an available port

The import check at `scripts/test-isolation.test.ts` enforces this rule: it
fails if any `*.test.ts` file outside the `integration` project imports a
value of `pipeline/serve/server.ts`, `pipeline/seed/run.ts`,
`bin/verbs/serve.ts`, or the `playwright` package. Type imports
(`import type { … }`) are allowed.

### Running tests

To run all tests:

```bash
bun run test
```

To run a single project:

```bash
bunx vitest run --project unit
bunx vitest run --project integration
```
