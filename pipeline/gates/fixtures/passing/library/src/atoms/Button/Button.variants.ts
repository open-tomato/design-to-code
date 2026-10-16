import { cva } from '../../lib/variants';

/** The classes of a `Button`, by `intent` and `size`. */
export const buttonVariants = cva('inline-flex items-center rounded font-medium disabled:opacity-50', {
  variants: {
    intent: {
      primary: 'bg-blue-600 text-white hover:bg-blue-700',
      secondary: 'bg-gray-100 text-gray-900 hover:bg-gray-200',
    },
    size: {
      md: 'h-9 px-4 text-sm',
      sm: 'h-7 px-2 text-xs',
    },
  },
  defaultVariants: {
    intent: 'primary',
    size: 'md',
  },
});
