import { Button } from '../../atoms/Button/Button';

import { Page } from './Page';

export default { title: 'layouts/Page', component: Page };

/** A story renders the layout, so it passes props freely. */
export const Home = {
  render: () => (
    <Page title="Home" actions={['Open']}>
      <Button tone="quiet">Go</Button>
    </Page>
  ),
};
