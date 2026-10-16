import type { Meta, StoryObj } from '@storybook/react-vite';

import { PageLayout } from './PageLayout';

const meta = {
  component: PageLayout,
} satisfies Meta<typeof PageLayout>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The `default` state. */
export const Default: Story = {
  args: { children: <p>Page content</p> },
};
