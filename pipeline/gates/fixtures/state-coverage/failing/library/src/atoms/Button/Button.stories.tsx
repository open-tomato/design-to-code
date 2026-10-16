import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from './Button';

const meta = {
  component: Button,
  args: { children: 'Save' },
} satisfies Meta<typeof Button>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The `default` state, covered by its identifier. */
export const Default: Story = {};

/** The `hover` state, covered by its `name` property. */
export const Hovered = {
  name: 'hover',
} satisfies Story;

/** A type export named for the `disabled` state: never a story. */
export type Disabled = Story;

/** Shows the disabled look, but neither its identifier nor its name is `disabled`'s. */
export const DisabledButton: Story = {
  name: 'Disabled button',
  args: { disabled: true },
};
