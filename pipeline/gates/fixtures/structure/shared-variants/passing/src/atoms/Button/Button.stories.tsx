import { Button } from './Button';
import { buttonVariants } from './Button.variants';

export default { title: 'atoms/Button', component: Button };

/** The quiet intent, shown on a plain element. */
export const Quiet = { render: () => <span className={buttonVariants('quiet')}>Quiet</span> };
