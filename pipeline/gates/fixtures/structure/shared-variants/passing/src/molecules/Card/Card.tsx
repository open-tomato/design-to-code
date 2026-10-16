import { Button } from '../../atoms/Button/Button';
import { buttonVariants } from '../../atoms/Button/Button.variants';

/** A card, the only component outside `Button` that imports its variants. */
export function Card() {
  return (
    <section className={buttonVariants('quiet')}>
      <Button>Open</Button>
    </section>
  );
}
