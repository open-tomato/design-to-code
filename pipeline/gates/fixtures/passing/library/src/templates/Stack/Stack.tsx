import type { VariantProps } from '../../lib/variants';
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';

import { stackVariants } from './Stack.variants';

/** The props of a `Stack`. */
export interface StackProps extends VariantProps<typeof stackVariants> {
  /** The stacked content, top to bottom. */
  readonly children?: ReactNode;
  /** Classes merged after the variant classes. */
  readonly className?: string;
}

/** Stacks its children in a column. */
export function Stack({ gap, className, children }: StackProps) {
  return <div className={cn(stackVariants({ gap }), className)}>{children}</div>;
}
