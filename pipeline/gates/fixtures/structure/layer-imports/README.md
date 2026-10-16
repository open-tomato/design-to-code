# `layer-imports` fixtures

Two libraries for the `layer-imports` structure rule, each a `target.dir`
read with the default `levels`.

- `failing/` breaks the rule twice: `src/atoms/Button/Button.tsx` line 3
  imports `Icon`, a component of its own level, and
  `src/molecules/Card/Card.tsx` line 2 imports `Header`, a component of a
  higher level, through an import statement spread over three lines. Its
  other imports point down a level.
- `passing/` imports only down a level, through a value import, a type
  import and a re-export, plus a file of the importer's own folder and a
  helper in `src/lib/`, which is no level folder.
