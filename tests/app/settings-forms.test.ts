// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkCatalogueTexts, type RotateResult, type SaveTextsResult } from '../../src/app/_admin/settings-data';
import { CatalogueTextsForm, RotateLinkForm, RotateOutcome } from '../../src/app/_admin/settings-forms';
import { MAX_CATALOGUE_TEXT } from '../../src/db/schema/catalogue-settings';

/**
 * `[PUB-9]` and `[PUB-15]` on `/admin/settings`: the texts are checked by the service's own schema
 * and a refusal shows on its field; the address only the admin sees; and Rotate catalogue link,
 * which runs only after a confirmation that says the old link stops working, and says so when the
 * old link was not fully removed. Every value is made up.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ADDRESS = 'https://made-up.cloudfront.test/c/made-up-token/';
const NEW_ADDRESS = 'https://made-up.cloudfront.test/c/made-up-new/';

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
}

async function submit(): Promise<void> {
  await act(async () => {
    (container.querySelector('button[type="submit"]') as HTMLButtonElement).click();
  });
  await settle();
}

async function submitRotate(confirmed: boolean, result: RotateResult = { status: 'rotated', url: NEW_ADDRESS, publishedAt: '2026-11-02T10:00:00.000Z', oldRemoved: true }) {
  const action = vi.fn(async () => result);
  const confirm = vi.fn(() => confirmed);
  vi.stubGlobal('confirm', confirm);
  await act(async () => root.render(createElement(RotateLinkForm, { action, url: ADDRESS })));
  await submit();
  return { action, confirm };
}

/** A text the textarea counts as exactly the limit, with its line breaks sent as CRLF, as a browser posts them. */
function fullTextWithCrlf(): string {
  const line = 'x'.repeat(99);
  const lines = Array.from({ length: 20 }, () => line);
  const text = lines.join('\n');
  const padded = text + 'y'.repeat(MAX_CATALOGUE_TEXT - text.length);
  expect(padded.length).toBe(MAX_CATALOGUE_TEXT);
  return padded.replaceAll('\n', '\r\n');
}

describe('the catalogue texts', () => {
  it('[PUB-9] holds both texts as plain-text fields, limited by the schema’s one limit, which the server passes in', () => {
    const html = renderToStaticMarkup(createElement(CatalogueTextsForm, { action: async () => ({ status: 'saved' as const }), introText: 'Made-up <b>intro</b>', contactText: 'Made-up contact', maxText: MAX_CATALOGUE_TEXT }));
    expect(html.match(new RegExp(`maxLength="${MAX_CATALOGUE_TEXT}"`, 'g'))).toHaveLength(2);
    expect(html).toContain('Made-up &lt;b&gt;intro&lt;/b&gt;');
  });

  it('[PUB-9] accepts a text at the limit whose line breaks arrive as CRLF, as the service would, and refuses one over it on its field', () => {
    const full = fullTextWithCrlf();
    expect(full.length).toBeGreaterThan(MAX_CATALOGUE_TEXT);
    expect(checkCatalogueTexts({ introText: full, contactText: full })).toBeNull();
    expect(checkCatalogueTexts({ introText: '', contactText: `${full}z` })).toEqual({ status: 'invalid', problems: { contactText: 'tooLong' } });
  });

  it('[PUB-9] shows a control character as a message on its field, not as a failed request', async () => {
    const refused = checkCatalogueTexts({ introText: 'Made-up \u0007 bell', contactText: 'Made-up\ttab\nand line' });
    expect(refused).toEqual({ status: 'invalid', problems: { introText: 'notPlain' } });
    const action = vi.fn(async (): Promise<SaveTextsResult> => refused as SaveTextsResult);
    await act(async () => root.render(createElement(CatalogueTextsForm, { action, introText: '', contactText: '', maxText: MAX_CATALOGUE_TEXT })));
    await submit();
    expect(action).toHaveBeenCalledOnce();
    const intro = container.querySelector('textarea[name="introText"]') as HTMLTextAreaElement;
    expect(intro.getAttribute('aria-invalid')).toBe('true');
    expect(intro.closest('label')?.querySelector('[role="alert"]')?.textContent).toContain('Plain text only');
    expect((container.querySelector('textarea[name="contactText"]') as HTMLTextAreaElement).getAttribute('aria-invalid')).toBeNull();
  });
});

describe('Rotate catalogue link', () => {
  it('[PUB-15] shows the current address to the admin, and asks before rotating, saying the old link stops working', async () => {
    const { action, confirm } = await submitRotate(false);
    expect(container.innerHTML).toContain(ADDRESS);
    expect(confirm).toHaveBeenCalledOnce();
    expect(String((confirm.mock.calls[0] as unknown[] | undefined)?.[0])).toContain('the old link stops working');
    expect(action).not.toHaveBeenCalled();
  });

  it('[PUB-15] rotates once confirmed and shows the new address', async () => {
    const { action } = await submitRotate(true);
    expect(action).toHaveBeenCalledOnce();
    expect(container.innerHTML).toContain(NEW_ADDRESS);
    expect(container.innerHTML).not.toContain(ADDRESS);
    expect(container.querySelector('[role="status"]')?.textContent).toContain('was rotated');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('[PUB-15] warns when the old link was not fully removed, and says to publish again', async () => {
    await submitRotate(true, { status: 'rotated', url: NEW_ADDRESS, publishedAt: '2026-11-02T10:00:00.000Z', oldRemoved: false });
    const alert = container.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alert).toContain('old link was not fully removed');
    expect(alert).toContain('up to a day');
    expect(alert).toContain('Publish again');
  });

  it('[PUB-15] says another publish is running when the rotation waited too long for its turn, and whether the old link still works', () => {
    const busy = renderToStaticMarkup(createElement(RotateOutcome, { result: { status: 'failed', requestId: 'req-busy', previousKept: true, busy: true } }));
    expect(busy).toContain('Another publish is running');
    expect(busy).toContain('The old link still works');
    const partial = renderToStaticMarkup(createElement(RotateOutcome, { result: { status: 'failed', requestId: 'req-2', previousKept: false } }));
    expect(partial).not.toContain('Another publish');
    expect(partial).toContain('rotate again');
    expect(partial).toContain('Reference: req-2');
  });
});
