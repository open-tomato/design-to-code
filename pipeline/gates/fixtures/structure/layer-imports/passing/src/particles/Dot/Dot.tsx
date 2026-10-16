import { cn } from '../../lib/cn';
import { cva } from '../../lib/variants';

/** The classes of a `Dot`. */
const dotVariants = cva('dot');

/** The props of a `Dot`. */
export interface DotProps {
  readonly className?: string;
}

/** A small decorative dot. */
export function Dot({ className }: DotProps) {
  return <span aria-hidden="true" className={cn(dotVariants(), className)} />;
}
