/**
 * The shared Storybook harness's Vite config: the plugins every story is
 * built with, whichever project is active.
 *
 * `harness/.storybook/main.ts` names it as Storybook's Vite config, and the
 * `storybook` project of `vitest.config.ts` extends it, so both builds share
 * one plugin list. The project's style entry is not added here: `main.ts`
 * adds it through `viteFinal`.
 *
 * @packageDocumentation
 */

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
});
