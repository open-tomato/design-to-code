import { cva } from '../../lib/variants';

/** The classes of a `Toolbar`, by `density`. */
export const toolbarVariants = cva('flex items-center border-b border-gray-200', {
  variants: {
    density: {
      comfortable: 'gap-3 p-3',
      compact: 'gap-1 p-1',
    },
  },
  defaultVariants: {
    density: 'comfortable',
  },
});
