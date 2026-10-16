import { cva } from '../../lib/variants';

/** The classes of a `Stack`, by `gap`. */
export const stackVariants = cva('flex flex-col', {
  variants: {
    gap: {
      md: 'gap-4',
      sm: 'gap-2',
    },
  },
  defaultVariants: {
    gap: 'md',
  },
});
