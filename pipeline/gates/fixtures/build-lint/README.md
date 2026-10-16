# `build-lint` fixtures

- `failing/library/` — a library the build and lint gate fails on, read
  with the default `levels`. It holds three components:
  - `particles/Dot` — no `className`, no hook, type-clean: it passes.
  - `atoms/Button` — `Button.tsx` sets `className` to a string literal
    (`d2c/cva-only-classname`, line 17), and `Button.stories.tsx` calls
    `useState` in its `Default` story's `render`
    (`react-hooks/rules-of-hooks`, line 19).
  - `molecules/Toolbar` — `Toolbar.tsx` passes the string `"yes"` to
    `Button`'s boolean `disabled` (`tsc`, `TS2322`, line 17).

The library has no `eslint.config.mjs`, so the gate lints it through
`templates/library/eslint.config.mjs`. Run the gate over a temp copy, so
its results never land in the repo; give the copy a link to the tool's
`node_modules`, which `tsc` resolves `react` and the Storybook types
through, and a `package.json`, without which `import/order` throws on the
first import it ranks.

The passing library is `../passing/library/`.
