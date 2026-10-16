# Passing fixture library

A library every local gate passes on. Its paths resolve against this
folder, so load it with this folder as the config root:
`loadProjectConfig({ rootDir, env: { D2C_PROJECT: 'passing' } })`.

- `projects/passing.json` — the project config: `source.dir` is `source`,
  `target.dir` is `library`, and `levels` is left to its default.
- `source/seed-manifest.json` — one component per level and its states.
- `library/` — the target library, laid out as `templates/library/` seeds
  it. Each level folder under `library/src/` holds one component, with a
  story per manifest state (the state name in PascalCase), its variants
  declared with `cva` in `<Name>.variants.ts`, and a `className` built as
  `cn(<variants call>, className)`.

| Level | Component | States |
| --- | --- | --- |
| `particles` | `Dot` | `default` |
| `atoms` | `Button` | `default`, `hover`, `disabled` |
| `molecules` | `Toolbar` | `default`, `with-actions` |
| `organisms` | `Header` | `default` |
| `templates` | `Stack` | `default` |
| `layouts` | `PageLayout` | `default` |

Imports only point down a level: `Header` renders `Button`, `Toolbar`
renders `Dot`, and `PageLayout` renders `Stack` passing it nothing but
`children`. No component folder holds an `index.ts`, so no story imports
through a barrel.

The root `tsconfig.json` and `eslint.config.mjs` exclude
`pipeline/gates/fixtures/**`; type-check this library on its own with
`bunx tsc --noEmit -p pipeline/gates/fixtures/passing/library`.
