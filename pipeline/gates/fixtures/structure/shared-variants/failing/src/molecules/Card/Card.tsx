import { Button } from '../../atoms/Button/Button';

import { buttonVariants } from '../../atoms/Button/Button.variants';

/** A card that borrows the variants of `Button`. */
export function Card() {
  return (
    <section className={buttonVariants('quiet')}>
      <Button>Open</Button>
    </section>
  );
}
