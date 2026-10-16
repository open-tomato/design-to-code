import type { Meta, StoryObj } from '@storybook/react-vite';

import { Stack } from './Stack';

const meta = {
  component: Stack,
} satisfies Meta<typeof Stack>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The `default` state. */
export const Default: Story = {
  args: {
    children: (
      <>
        <p>First</p>
        <p>Second</p>
      </>
    ),
  },
};
