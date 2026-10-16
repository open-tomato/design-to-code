# `layout-children-only` fixtures

Two libraries for the `layout-children-only` structure rule, each a
`target.dir` read with the default `levels`, whose highest level is
`layouts`.

- `failing/` breaks the rule twice, in `src/layouts/Page/Page.tsx`: line 18
  renders `Header` with a `title` attribute beside an allowed `key`, and
  line 19 renders `Atoms.Button`, bound by a namespace import, with a
  spread attribute. Every import points down a level and no variants file
  is shared, so it breaks no other structure rule.
- `passing/` hands the page title to `Header` through a context from
  `src/lib/`, and passes library components only `children` (as content
  and as an attribute) and `key`. It also holds what the rule leaves
  alone: attributes on an intrinsic element, on a part of the layout's own
  folder and on the context provider from `src/lib/`; a type-only import
  of a library component; an organism passing props to `Button`; and the
  layout's story passing props to `Page` and `Button`.
