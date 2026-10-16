# `no-pages-folder` fixtures

Two libraries for the `no-pages-folder` structure rule, each a `target.dir`
read with the default `levels`.

- `failing/` holds two `pages` folders under `src`: `src/pages/` beside the
  level folders, and `src/organisms/Header/pages/` inside a component. Its
  imports point down a level and no variants file is shared, so it breaks no
  other structure rule.
- `passing/` holds no `pages` folder under `src`. It keeps what the rule
  leaves alone: a component whose name merely starts with `Page`
  (`src/organisms/Pager/`) and a `pages/` folder outside `src`, at the
  library root.
