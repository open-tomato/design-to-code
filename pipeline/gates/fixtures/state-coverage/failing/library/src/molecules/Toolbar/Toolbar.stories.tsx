import type { Meta, StoryObj } from '@storybook/react-vite';

import { Toolbar } from './Toolbar';

const meta = {
  component: Toolbar,
} satisfies Meta<typeof Toolbar>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The `default` state. */
export const Default: Story = {};

/** The `with-actions` state. */
export const WithActions: Story = {
  args: { children: <span>Actions</span> },
};
