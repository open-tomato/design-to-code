import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ButtonProps } from '../../atoms/Button';

import { Button } from '../../atoms/Button';
import { Dot } from '../../index';

import { Toolbar } from './Toolbar';

const meta = { component: Toolbar } satisfies Meta<typeof Toolbar>;

export default meta;

const label: ButtonProps['children'] = 'Save';

export const WithActions: StoryObj<typeof meta> = {
  args: { children: <><Dot /><Button>{label}</Button></> },
};
