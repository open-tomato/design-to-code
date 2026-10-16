import { cva } from '../../lib/variants';

/** The classes of a `PageLayout`, by `width`. */
export const pageLayoutVariants = cva('mx-auto min-h-screen', {
  variants: {
    width: {
      full: 'w-full',
      narrow: 'max-w-3xl',
    },
  },
  defaultVariants: {
    width: 'full',
  },
});
