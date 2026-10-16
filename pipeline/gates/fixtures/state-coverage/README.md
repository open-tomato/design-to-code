# `state-coverage` fixtures

- `failing/` — a library the state coverage gate fails on, read with the
  default `levels`: `source/` is its `source.dir`, holding
  `seed-manifest.json`, and `library/` its `target.dir`. The manifest
  names `Button` (`default`, `hover`, `disabled`) and `Toolbar`
  (`default`, `with-actions`). `Toolbar` covers both states by export
  identifier. `Button` covers `default` by identifier and `hover` by a
  story whose `name` is `hover`, and leaves `disabled` uncovered: its
  `Disabled` export is a type, and its `DisabledButton` story is named
  `Disabled button`, so neither counts. The gate writes one
  `missing-state-story` finding, for `Button`'s `disabled`, and passes
  `Toolbar`.

The passing library is `../passing/`, whose `source/seed-manifest.json`
every story under `library/` covers.
