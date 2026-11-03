import { describe, expect, it } from 'vitest';
import { readRepoFile } from '../support/repo-file';

/**
 * `docs/design/ui.md` and #203: the admin's stylesheet keeps the entry form and the settings to one
 * column of 640 px, and gives the overview (`/admin`, `.page--wide`) small gutters on a phone and,
 * from 720 px, a wider page whose item list is a grid of two, then three, columns. The loading
 * screen's spinner stands still for a device that asks for reduced motion.
 */

/** The stylesheet without its comments. */
const css = readRepoFile('src/app/admin.css').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of `selector`'s rule, at the top level or inside the `@media` block whose condition is `media`. */
function declarations(selector: string, media?: string): Record<string, string> {
  let scope: string;
  if (media !== undefined) {
    const start = css.indexOf(`@media ${media} {`);
    expect(start, `no @media ${media}`).toBeGreaterThan(-1);
    let depth = 0;
    let end = start;
    for (let index = css.indexOf('{', start); index < css.length; index++) {
      if (css[index] === '{') depth++;
      if (css[index] === '}' && --depth === 0) {
        end = index;
        break;
      }
    }
    scope = css.slice(css.indexOf('{', start) + 1, end);
  } else {
    scope = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  }
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(scope);
  expect(match, `no rule for ${selector}${media === undefined ? '' : ` in ${media}`}`).not.toBeNull();
  return Object.fromEntries(
    (match?.[1] ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.includes(':'))
      .map((part) => [part.slice(0, part.indexOf(':')).trim(), part.slice(part.indexOf(':') + 1).trim()]),
  );
}

describe('the admin’s layout', () => {
  it('[ITEM-8] [ITEM-9] keeps every page but the overview to one column of 640 px, with the 16 px gutter', () => {
    expect(declarations('.page')['max-width']).toBe('640px');
    expect(declarations(':root')['--gutter']).toBe('16px');
    expect(declarations('.action-bar')['max-width']).toBe('640px');
  });

  it('[ITEM-8] gives the overview 8 px gutters on a phone', () => {
    expect(declarations('.page--wide')['--gutter']).toBe('var(--s2)');
    expect(declarations(':root')['--s2']).toBe('8px');
  });

  it('[ITEM-8] widens the overview from 720 px into a grid of two columns, and three from 1100 px, its action bar with it', () => {
    expect(declarations('.page--wide', '(min-width: 720px)')['max-width']).toBe('1200px');
    expect(declarations('.page--wide .item-list', '(min-width: 720px)')).toMatchObject({ display: 'grid', 'grid-template-columns': 'repeat(2, minmax(0, 1fr))' });
    expect(declarations('.page--wide .action-bar', '(min-width: 720px)')['max-width']).toBe('1200px');
    expect(declarations('.page--wide .item-list', '(min-width: 1100px)')['grid-template-columns']).toBe('repeat(3, minmax(0, 1fr))');
  });

  it('[ITEM-8] is the overview’s alone: only /admin opens a wide page', () => {
    expect(readRepoFile('src/app/admin/page.tsx')).toContain('<Page wide>');
    for (const file of ['src/app/admin/items/new/page.tsx', 'src/app/admin/items/[id]/page.tsx', 'src/app/admin/settings/page.tsx', 'src/app/offline/page.tsx']) {
      expect(readRepoFile(file), file).not.toContain('wide');
    }
  });

  it('[PLAT-16] spins the loading screen’s spinner, and stills it for reduced motion', () => {
    expect(declarations('.spinner').animation).toMatch(/^spinner /);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.spinner \{ animation: none; \}/);
  });
});
