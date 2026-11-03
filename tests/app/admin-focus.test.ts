import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The admin stylesheet's focus outline (`docs/design/ui.md`, Tokens). The form focuses the set
 * search after Save & add next ([ITEM-9]); an outline in the accent's red read as an error there,
 * so focus has its own token, distinct from both the accent and the danger colour, in each theme.
 */
const css = readFileSync('src/app/admin.css', 'utf8');

function tokens(name: string): string[] {
  return [...css.matchAll(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`, 'g'))].map((match) => (match[1] ?? '').toLowerCase());
}

describe('the admin stylesheet', () => {
  it('[ITEM-9] draws focus in its own colour, never the accent or the danger red, in every theme', () => {
    const focus = tokens('focus');
    expect(focus.length).toBeGreaterThanOrEqual(2);
    for (const colour of focus) {
      expect(tokens('danger')).not.toContain(colour);
      expect(tokens('accent')).not.toContain(colour);
    }
    for (const rule of css.matchAll(/:focus-visible\)?\s*\{[^}]*\}/g)) expect(rule[0]).toContain('var(--focus)');
    expect(css).not.toMatch(/outline:\s*2px solid var\(--accent\)/);
  });
});
