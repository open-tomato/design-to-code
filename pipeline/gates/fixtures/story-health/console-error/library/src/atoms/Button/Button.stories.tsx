import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from './Button';

const meta = {
  component: Button,
  args: { children: 'Save' },
} satisfies Meta<typeof Button>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The `default` state, which renders clean. */
export const Default: Story = {};

/** The `broken` state, whose render logs a console error. */
export const Broken: Story = {
  render: (args) => {
    console.error('Button.stories.tsx: this story logs a console error when it renders');

    return <Button {...args} />;
  },
};
