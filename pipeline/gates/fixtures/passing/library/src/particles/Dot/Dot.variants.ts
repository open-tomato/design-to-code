import { cva } from '../../lib/variants';

/** The classes of a `Dot`, by `tone`. */
export const dotVariants = cva('inline-block size-2 rounded-full', {
  variants: {
    tone: {
      neutral: 'bg-gray-400',
      accent: 'bg-blue-600',
    },
  },
  defaultVariants: {
    tone: 'neutral',
  },
});
