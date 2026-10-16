import type { Meta, StoryObj } from '@storybook/react-vite';

import { useState } from 'react';

import { Button } from './Button';

const meta = {
  component: Button,
  args: { children: 'Save' },
} satisfies Meta<typeof Button>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The `default` state, whose render calls a hook. */
export const Default: Story = {
  render: (args) => {
    const [label] = useState('Save');
    return <Button {...args}>{label}</Button>;
  },
};
