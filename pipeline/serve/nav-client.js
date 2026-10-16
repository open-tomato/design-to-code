/**
 * The serve verb's nav bar, browser side: the body of the one classic
 * `<script>` the server injects before the last `</body>` of every HTML
 * response (see `nav.ts`), read once when the server starts.
 *
 * It is one IIFE, so it defines no globals. It appends one host element to
 * `document.body`, attaches an open shadow root to it and renders there, so
 * no style of the overlay can reach a page element. Collapsed, the overlay
 * is a small tab pinned to the bottom right corner; expanded, it lists
 * every discovered page as `GET /__d2c/pages` returns the nav model: each
 * version group in its listed order, then the pages in no group. Each entry
 * is a link to the page plus keep and discard buttons, the saved choice
 * pressed. A button posts `{ page, choice }` to `POST /__d2c/pages` and
 * re-reads the list once the server accepts it.
 *
 * Nothing the overlay draws may paint outside the host's box (no shadow,
 * no outline offset), so a screenshot of the page outside that box is the
 * same with and without the nav bar.
 *
 * @packageDocumentation
 */

(() => {
  'use strict';

  const PAGES_ENDPOINT = '/__d2c/pages';

  const HOST_TAG = 'd2c-nav';

  /** Declarations that pin the host whatever the page's own CSS says. */
  const HOST_STYLE = [
    'all: initial !important',
    'position: fixed !important',
    'right: 0 !important',
    'bottom: 0 !important',
    'z-index: 2147483647 !important',
    'display: block !important',
  ].join('; ');

  const SHADOW_CSS = `
    :host { all: initial; }
    .root {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      font: 12px/1.4 system-ui, sans-serif;
      color: #1f2328;
    }
    .tab {
      font: inherit;
      margin: 0;
      padding: 4px 10px;
      border: 1px solid #8c959f;
      border-radius: 6px 0 0 0;
      background: #f6f8fa;
      color: inherit;
      cursor: pointer;
    }
    .tab:focus-visible, button:focus-visible, a:focus-visible {
      outline: 2px solid #0969da;
      outline-offset: -2px;
    }
    .panel {
      box-sizing: border-box;
      width: 360px;
      max-height: 70vh;
      overflow: auto;
      padding: 8px;
      border: 1px solid #8c959f;
      border-bottom: none;
      border-radius: 6px 0 0 0;
      background: #ffffff;
    }
    .panel[hidden] { display: none; }
    h2 { margin: 0 0 4px; font-size: 12px; font-weight: 600; }
    section + section { margin-top: 8px; }
    ul { margin: 0; padding: 0; list-style: none; }
    li {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 2px 0;
    }
    li.discarded a { color: #8c959f; text-decoration: line-through; }
    a { flex: 1; min-width: 0; color: #0969da; overflow-wrap: anywhere; }
    a[aria-current="page"] { font-weight: 600; }
    .path { display: block; color: #57606a; font-size: 11px; }
    button.choice {
      font: inherit;
      margin: 0;
      padding: 1px 6px;
      border: 1px solid #8c959f;
      border-radius: 4px;
      background: #ffffff;
      color: inherit;
      cursor: pointer;
    }
    button.choice[aria-pressed="true"] { background: #1f2328; color: #ffffff; }
    .status { margin: 4px 0 0; color: #cf222e; }
    .status:empty { display: none; }
  `;

  /** The page choice each state maps to, and the button label for it. */
  const CHOICES = [
    { choice: 'keep', state: 'kept', label: 'Keep' },
    { choice: 'discard', state: 'discarded', label: 'Discard' },
  ];

  const element = (tag, className, text) => {
    const node = document.createElement(tag);

    if (className) {
      node.className = className;
    }

    if (text !== undefined) {
      node.textContent = text;
    }

    return node;
  };

  /** The URL of a page path relative to `source.dir`, each segment encoded. */
  const pageHref = (path) => `/${path.split('/').map(encodeURIComponent)
    .join('/')}`;

  const currentPath = (() => {
    try {
      return decodeURIComponent(location.pathname).replace(/^\//, '');
    } catch {
      return '';
    }
  })();

  const host = document.createElement(HOST_TAG);

  host.setAttribute('style', HOST_STYLE);

  const shadow = host.attachShadow({ mode: 'open' });
  const style = element('style');
  const root = element('div', 'root');
  const panel = element('div', 'panel');
  const list = element('div', 'list');
  const status = element('p', 'status');
  const tab = element('button', 'tab', 'd2c pages');

  style.textContent = SHADOW_CSS;
  panel.hidden = true;
  panel.id = 'd2c-nav-panel';
  status.setAttribute('role', 'status');
  tab.type = 'button';
  tab.setAttribute('aria-expanded', 'false');
  tab.setAttribute('aria-controls', panel.id);
  panel.append(list, status);
  root.append(panel, tab);
  shadow.append(style, root);

  const setStatus = (message) => {
    status.textContent = message;
  };

  const renderPage = (page, onChoose) => {
    const item = element('li', page.state);
    const link = element('a', '', page.title ?? page.path);

    link.href = pageHref(page.path);

    if (page.path === currentPath) {
      link.setAttribute('aria-current', 'page');
    }

    if (page.title !== null) {
      link.append(element('span', 'path', page.path));
    }

    item.append(link);

    CHOICES.forEach(({ choice, state, label }) => {
      const button = element('button', 'choice', label);

      button.type = 'button';
      button.setAttribute('aria-pressed', String(page.state === state));
      button.addEventListener('click', () => onChoose(page.path, choice));
      item.append(button);
    });

    return item;
  };

  const renderSection = (heading, pages, onChoose) => {
    const section = element('section');
    const items = element('ul');

    items.append(...pages.map((page) => renderPage(page, onChoose)));
    section.append(element('h2', '', heading), items);

    return section;
  };

  const render = (model, onChoose) => {
    const sections = model.groups.map((group, index) => renderSection(`Version group ${index + 1}`, group.pages, onChoose));

    if (model.ungrouped.length > 0) {
      sections.push(renderSection(model.groups.length > 0
        ? 'Other pages'
        : 'Pages', model.ungrouped, onChoose));
    }

    list.replaceChildren(...sections);
  };

  const readModel = async () => {
    const response = await fetch(PAGES_ENDPOINT, { cache: 'no-store', headers: { accept: 'application/json' } });

    if (!response.ok) {
      throw new Error(`${PAGES_ENDPOINT} answered ${response.status}: ${(await response.text()).trim()}`);
    }

    return response.json();
  };

  const refresh = async () => {
    try {
      render(await readModel(), choose);
    } catch (error) {
      setStatus(`cannot list pages: ${error instanceof Error
        ? error.message
        : String(error)}`);
    }
  };

  const choose = async (page, choice) => {
    setStatus('');

    try {
      const response = await fetch(PAGES_ENDPOINT, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ page, choice }),
      });

      if (!response.ok) {
        setStatus(`cannot ${choice} ${page}: ${response.status} ${(await response.text()).trim()}`);

        return;
      }
    } catch (error) {
      setStatus(`cannot ${choice} ${page}: ${error instanceof Error
        ? error.message
        : String(error)}`);

      return;
    }

    await refresh();
  };

  tab.addEventListener('click', () => {
    const expanded = panel.hidden;

    panel.hidden = !expanded;
    tab.setAttribute('aria-expanded', String(expanded));
  });

  document.body.append(host);
  refresh();
})();
