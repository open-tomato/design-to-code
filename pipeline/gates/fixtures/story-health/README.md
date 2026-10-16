# `story-health` fixtures

- `failing/` — fails every static check of the story health gate:
  - `library/` is a `target.dir`, read with the default `levels`. It holds
    three components:
    - `particles/Dot` — a story importing only its own component: it
      passes.
    - `atoms/Button` — `Button.stories.tsx` imports `expect` from `vitest`
      (`no-vitest-in-stories`, line 3). It also imports its own folder's
      `index.ts`, which is not cross-folder and is no finding.
    - `molecules/Toolbar` — `Toolbar.stories.tsx` imports `Button` through
      `../../atoms/Button`, the folder holding `index.ts`
      (`no-cross-folder-barrel`, line 4), and `Dot` through
      `../../index`, the library's `src/index.ts` (`no-cross-folder-barrel`,
      line 5). Its type-only import of `../../atoms/Button` on line 2 is
      erased before the build and is no finding.
  - `preview.ts` is a Storybook preview exporting `FIXED_CLOCK` but no
    `RANDOM_SEED` (`preview-deterministic`, one `_library` finding).

The passing library is `../passing/library/`, whose stories import no
`vitest` and no barrel; the passing preview is the harness's own,
`harness/.storybook/preview.ts`.

- `console-error/` — fails the rendered check of the story health gate only:
  - `library/` is a `target.dir`, read with the default `levels`. It holds
    one component, `atoms/Button`, whose `Button.stories.tsx` has a
    `Default` story that renders clean and a `Broken` story whose render
    calls `console.error` (`story-renders-clean`, `button--broken`). It
    imports no `vitest` and no barrel, and has no `preview.ts` of its own:
    the harness's preview is the one built.
