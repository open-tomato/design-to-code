import { dotVariants } from './Dot.variants';

/** A small decorative dot. */
export function Dot() {
  return <span aria-hidden="true" className={dotVariants()} />;
}
