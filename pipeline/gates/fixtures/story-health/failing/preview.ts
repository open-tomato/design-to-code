/**
 * A harness preview that fixes the clock but leaves `Math.random` unseeded:
 * it exports `FIXED_CLOCK` and no `RANDOM_SEED`.
 */
import type { Preview } from '@storybook/react-vite';

export const FIXED_CLOCK = Date.UTC(2024, 0, 1);

const preview: Preview = {};

export default preview;
