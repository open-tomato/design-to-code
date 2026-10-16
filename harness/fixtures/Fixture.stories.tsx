/**
 * The harness's own fixture story, loaded whatever the active project.
 *
 * Its `play` function asserts the text the fixture renders, so a harness
 * that loads or renders no story fails its run instead of passing on an
 * empty set.
 *
 * @packageDocumentation
 */

import type { Meta, StoryObj } from '@storybook/react-vite';

import { expect } from 'storybook/test';

/** Renders a fixed line of text for the fixture story to assert. */
function Fixture() {
  return <p>Shared harness fixture</p>;
}

const meta = {
  title: 'Fixture',
  component: Fixture,
} satisfies Meta<typeof Fixture>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Renders the fixture and asserts its text. The expected text is written
 * out here rather than shared with {@link Fixture}, so changing either one
 * alone fails the story.
 */
export const Renders: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByText('Shared harness fixture')).toBeVisible();
  },
};
