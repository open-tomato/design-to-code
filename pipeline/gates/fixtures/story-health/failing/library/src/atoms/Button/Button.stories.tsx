import type { Meta, StoryObj } from '@storybook/react-vite';

import { expect } from 'vitest';

import { Button } from './index';

const meta = { component: Button, args: { children: 'Save' } } satisfies Meta<typeof Button>;

export default meta;

export const Default: StoryObj<typeof meta> = {
  play: () => {
    expect(true).toBe(true);
  },
};
