/**
 * Variant map of the `with-ds` fixture export, standing in for the
 * `system/variants.ts` of a Claude Design export.
 *
 * @packageDocumentation
 */

/** The button's variant and size options, each mapped to its class names. */
export const buttonVariants = {
  variant: {
    primary: 'btn btn-primary',
    ghost: 'btn btn-ghost',
  },
  size: {
    md: 'btn-md',
    lg: 'btn-lg',
  },
} as const;
