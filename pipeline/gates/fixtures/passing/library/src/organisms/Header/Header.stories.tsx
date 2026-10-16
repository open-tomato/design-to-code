import type { Meta, StoryObj } from '@storybook/react-vite';

import { Header } from './Header';

const meta = {
  component: Header,
  args: { title: 'Dashboard' },
} satisfies Meta<typeof Header>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The `default` state. */
export const Default: Story = {};
