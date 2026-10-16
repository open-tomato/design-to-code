import { Button } from '../../atoms/Button/Button';
import {
  Header,
} from '../../organisms/Header/Header';

/** A card that imports `Header`, a component of a higher level. */
export function Card() {
  return (
    <section>
      <Header title="Card" />
      <Button>Open</Button>
    </section>
  );
}
