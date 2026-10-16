import type { VariantProps } from '../../lib/variants';

import { cn } from '../../lib/cn';

import { dotVariants } from './Dot.variants';

/** The props of a `Dot`: its `tone` and a passthrough `className`. */
export interface DotProps extends VariantProps<typeof dotVariants> {
  /** Classes merged after the variant classes. */
  readonly className?: string;
}

/** A small decorative dot. */
export function Dot({ tone, className }: DotProps) {
  return <span aria-hidden="true" className={cn(dotVariants({ tone }), className)} />;
}
