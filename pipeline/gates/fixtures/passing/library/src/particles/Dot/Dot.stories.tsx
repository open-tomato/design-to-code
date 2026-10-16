import type { Meta, StoryObj } from '@storybook/react-vite';

import { Dot } from './Dot';

const meta = {
  component: Dot,
} satisfies Meta<typeof Dot>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The `default` state. */
export const Default: Story = {
  args: { tone: 'neutral' },
};
