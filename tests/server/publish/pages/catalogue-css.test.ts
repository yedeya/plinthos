import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CATALOGUE_CSS } from '../../../../src/server/publish/pages/catalogue-css';

/**
 * The public catalogue's focus outline (`docs/design/catalogue.md`, `docs/design/ui.md`, #197).
 * The catalogue reuses the admin's tokens, so it draws focus with the admin's `--focus` blue,
 * the same value in each theme, and never as an outline in its accent red.
 */
const admin = readFileSync('src/app/admin.css', 'utf8');

function tokens(css: string, name: string): string[] {
  return [...css.matchAll(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`, 'g'))].map((match) => (match[1] ?? '').toLowerCase());
}

/** WCAG 2's relative luminance of a `#rrggbb` colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

describe('the public catalogue stylesheet', () => {
  it("carries the admin's --focus token, light and dark, and draws every focus outline with it", () => {
    const focus = tokens(CATALOGUE_CSS, 'focus');
    expect(focus).toHaveLength(2);
    expect(focus).toEqual(tokens(admin, 'focus'));
    for (const colour of focus) expect(tokens(CATALOGUE_CSS, 'accent')).not.toContain(colour);
    const rules = [...CATALOGUE_CSS.matchAll(/:focus-visible\)?\s*\{[^}]*\}/g)];
    expect(rules.length).toBeGreaterThanOrEqual(2);
    for (const rule of rules) expect(rule[0]).toContain('outline: 2px solid var(--focus)');
    expect(CATALOGUE_CSS).not.toMatch(/outline:[^;}]*var\(--accent\)/);
  });

  it('keeps the focus outline at 3:1 or more against the backgrounds it sits on, in each theme', () => {
    const [focusLight, focusDark] = tokens(CATALOGUE_CSS, 'focus');
    const [bgLight, bgDark] = tokens(CATALOGUE_CSS, 'bg');
    const [surfaceLight, surfaceDark] = tokens(CATALOGUE_CSS, 'surface');
    for (const [focus, backgrounds] of [
      [focusLight, [bgLight, surfaceLight]],
      [focusDark, [bgDark, surfaceDark]],
    ] as const) {
      for (const background of backgrounds) expect(contrast(focus ?? '', background ?? '')).toBeGreaterThanOrEqual(3);
    }
  });
});
