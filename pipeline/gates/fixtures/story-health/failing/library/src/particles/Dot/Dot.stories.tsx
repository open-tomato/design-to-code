import type { Meta, StoryObj } from '@storybook/react-vite';

import { Dot } from './Dot';

const meta = { component: Dot } satisfies Meta<typeof Dot>;

export default meta;

export const Default: StoryObj<typeof meta> = {};
