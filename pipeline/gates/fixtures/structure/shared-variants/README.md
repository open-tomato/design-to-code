# `shared-variants` fixtures

Two libraries for the `shared-variants` structure rule, each a `target.dir`
read with the default `levels`.

- `failing/` breaks the rule once: `src/atoms/Button/Button.variants.ts` is
  imported by two components outside its folder, `Card`
  (`src/molecules/Card/Card.tsx` line 3, without an extension) and `Header`
  (`src/organisms/Header/Header.tsx` line 4, with a `.js` extension). Every
  import points down a level, so it breaks no other structure rule.
- `passing/` shares variants only where the rule allows:
  `src/atoms/Button/Button.variants.ts` is imported by `Button` and its
  story (its own folder) and by one other component, `Card`; and
  `src/particles/Dot/Dot.variants.ts` is imported by two atoms, `Button`
  and `Badge`, which is no finding since `particles` is already the lowest
  level.
