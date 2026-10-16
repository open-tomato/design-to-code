import type { VariantProps } from '../../lib/variants';
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';

import { buttonVariants } from './Button.variants';

/** The props of a `Button`. */
export interface ButtonProps extends VariantProps<typeof buttonVariants> {
  /** The button's label. */
  readonly children: ReactNode;
  /** Whether the button refuses presses. */
  readonly disabled?: boolean;
  /** Classes merged after the variant classes. */
  readonly className?: string;
}

/** A button in one of two intents and two sizes. */
export function Button({ intent, size, disabled, className, children }: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(buttonVariants({ intent, size }), className)}
    >
      {children}
    </button>
  );
}
