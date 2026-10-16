import { describe, expect, test } from 'vitest';

import { describeCaseCollisions, findCaseCollisions } from './case-fold.ts';

describe('findCaseCollisions', () => {
  test('finds two files whose paths differ only in case', () => {
    expect(findCaseCollisions(['a.html', 'A.html'])).toStrictEqual([{ key: 'a.html', spellings: ['A.html', 'a.html'] }]);
  });

  test('finds two folder prefixes that differ only in case, even over different files', () => {
    expect(findCaseCollisions(['Pages/a.html', 'pages/b.html'])).toStrictEqual([{ key: 'pages', spellings: ['Pages', 'pages'] }]);
  });

  test('finds a deeper folder prefix under an agreeing parent', () => {
    expect(findCaseCollisions(['site/Img/a.png', 'site/img/b.png'])).toStrictEqual([
      { key: 'site/img', spellings: ['site/Img', 'site/img'] },
    ]);
  });

  test('finds a file whose path folds onto a folder', () => {
    expect(findCaseCollisions(['Pages', 'pages/a.html'])).toStrictEqual([{ key: 'pages', spellings: ['Pages', 'pages'] }]);
  });

  test('lists every colliding key, sorted, with every spelling', () => {
    const collisions = findCaseCollisions(['b.css', 'B.css', 'Pages/x.html', 'PAGES/x.html', 'pages/y.html']);

    expect(collisions).toStrictEqual([
      { key: 'b.css', spellings: ['B.css', 'b.css'] },
      { key: 'pages', spellings: ['PAGES', 'Pages', 'pages'] },
      { key: 'pages/x.html', spellings: ['PAGES/x.html', 'Pages/x.html'] },
    ]);
  });

  test('keeps whole paths with extensions, so Button.tsx beside button.css does not collide', () => {
    expect(findCaseCollisions(['Button.tsx', 'button.css'])).toStrictEqual([]);
  });

  test('does not count one spelling given twice', () => {
    expect(findCaseCollisions(['pages/a.html', 'pages/a.html', 'pages/b.html'])).toStrictEqual([]);
  });

  test('finds nothing in an empty list', () => {
    expect(findCaseCollisions([])).toStrictEqual([]);
  });

  test('ignores empty segments, as a directory entry\'s trailing slash leaves', () => {
    expect(findCaseCollisions(['Pages/', 'pages/a.html'])).toStrictEqual([{ key: 'pages', spellings: ['Pages', 'pages'] }]);
  });
});

describe('describeCaseCollisions', () => {
  test('names the origin and both spellings of every key, one line each', () => {
    const message = describeCaseCollisions('export.zip', findCaseCollisions(['a.html', 'A.html', 'Pages/b.html', 'pages/c.html']));

    expect(message).toBe([
      'export.zip: refused, nothing was written; these paths differ only in case, and a case-insensitive file system holds only one of each:',
      '  "A.html" and "a.html"',
      '  "Pages" and "pages"',
    ].join('\n'));
  });
});
