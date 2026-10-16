import { cva } from '../../lib/variants';

/** The classes of a `Header`, by `elevation`. */
export const headerVariants = cva('flex items-center justify-between px-4 py-2', {
  variants: {
    elevation: {
      flat: 'border-b border-gray-200',
      raised: 'shadow-md',
    },
  },
  defaultVariants: {
    elevation: 'flat',
  },
});
