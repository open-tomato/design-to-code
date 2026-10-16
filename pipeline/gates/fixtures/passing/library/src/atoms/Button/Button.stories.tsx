import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from './Button';

const meta = {
  component: Button,
  args: { children: 'Save' },
} satisfies Meta<typeof Button>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The `default` state. */
export const Default: Story = {};

/** The `hover` state, driven by hovering the button. */
export const Hover: Story = {
  args: { intent: 'secondary' },
};

/** The `disabled` state. */
export const Disabled: Story = {
  args: { disabled: true },
};
