import type { DotProps } from '../../particles/Dot/Dot';

import { Button } from '../../atoms/Button/Button';

export { ButtonLabel } from '../../atoms/Button/ButtonLabel';

/** The props of a `Card`: the props of its marker dot. */
export type CardProps = DotProps;

/** A card that imports only from lower levels. */
export function Card({ className }: CardProps) {
  return (
    <section className={className}>
      <Button>Open</Button>
    </section>
  );
}
