/**
 * Tests for `order.ts`: {@link extractionOrder} over hand-built entries
 * and {@link assertContainmentOrder} over hand-built containment maps, each
 * violation paired with a satisfied control.
 *
 * @packageDocumentation
 */

import type { OrderableEntry } from './order.ts';

import { describe, expect, test } from 'vitest';

import { assertContainmentOrder, extractionOrder } from './order.ts';

const organism: OrderableEntry = { name: 'Header', level: 'organism', page: '/a.html' };
const molecule: OrderableEntry = { name: 'Search', level: 'molecule', page: '/a.html' };
const atom: OrderableEntry = { name: 'Button', level: 'atom', page: '/a.html' };
const particle: OrderableEntry = { name: 'Dot', level: 'particle', page: '/b.html' };

describe('extractionOrder', () => {
  test('orders particles and atoms before molecules and organisms', () => {
    const ordered = extractionOrder([organism, molecule, atom, particle]);

    expect(ordered.map((entry) => entry.name)).toEqual(['Dot', 'Button', 'Search', 'Header']);
  });

  test('breaks level ties by page path, then by name', () => {
    const zOnA: OrderableEntry = { name: 'Zeta', level: 'atom', page: '/a.html' };
    const aOnB: OrderableEntry = { name: 'Alpha', level: 'atom', page: '/b.html' };
    const aOnA: OrderableEntry = { name: 'Alpha', level: 'atom', page: '/a.html' };

    const ordered = extractionOrder([aOnB, zOnA, aOnA]);

    expect(ordered).toEqual([aOnA, zOnA, aOnB]);
  });

  test('leaves the input array unmodified', () => {
    const input = [organism, atom, molecule];
    const snapshot = [...input];

    const ordered = extractionOrder(input);

    expect(input).toEqual(snapshot);
    expect(ordered).not.toBe(input);
    expect(ordered).not.toEqual(input);
  });
});

describe('assertContainmentOrder', () => {
  const contains = new Map([['Search', ['Button']]]);

  test('passes when every container follows what it contains', () => {
    expect(() => assertContainmentOrder(extractionOrder([molecule, atom]), contains)).not.toThrow();
  });

  test('throws naming both entries when a container precedes one it contains', () => {
    expect(() => assertContainmentOrder([molecule, atom], contains)).toThrow(
      'extraction order violated: "Search" precedes "Button", which it contains',
    );
  });

  test('ignores names that are not in the ordered list', () => {
    const map = new Map([['Missing', ['Button']], ['Search', ['Gone']]]);

    expect(() => assertContainmentOrder([molecule, atom], map)).not.toThrow();
  });
});
