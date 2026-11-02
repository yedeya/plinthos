// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogueTextsInput, CATALOGUE_TEXT_MAX, rotateCatalogueToken, saveCatalogueTexts, StandInError } from '../../src/app/_admin/settings-data';
import { CatalogueTextsForm, RotateLinkForm, RotateOutcome } from '../../src/app/_admin/settings-forms';
import { NotAdminError, type AdminContext } from '../../src/server/auth/admin-context';

/**
 * `[PUB-9]` and `[PUB-15]` on `/admin/settings`: the two texts' limit, the address only the admin
 * sees, and Rotate catalogue link, which runs only after a confirmation that says the old link
 * stops working. Every value is made up.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const URL = 'https://made-up.cloudfront.test/c/made-up-token/';

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

async function submitRotate(confirmed: boolean) {
  const action = vi.fn(async () => ({ status: 'rotated' as const, url: 'https://made-up.cloudfront.test/c/made-up-new/' }));
  const confirm = vi.fn(() => confirmed);
  vi.stubGlobal('confirm', confirm);
  await act(async () => root.render(createElement(RotateLinkForm, { action, url: URL })));
  const form = container.querySelector('form') as HTMLFormElement;
  await act(async () => {
    (form.querySelector('button[type="submit"]') as HTMLButtonElement).click();
  });
  for (let i = 0; i < 5; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
  return { action, confirm };
}

describe('the settings forms', () => {
  it('[PUB-9] holds both texts as plain-text fields of at most 2,000 characters, the service function’s own limit', () => {
    const html = renderToStaticMarkup(createElement(CatalogueTextsForm, { action: async () => ({ status: 'saved' as const }), introText: 'Made-up <b>intro</b>', contactText: 'Made-up contact' }));
    expect(CATALOGUE_TEXT_MAX).toBe(2000);
    expect(html.match(/maxLength="2000"/g)).toHaveLength(2);
    expect(html).toContain('Made-up &lt;b&gt;intro&lt;/b&gt;');
    expect(CatalogueTextsInput.safeParse({ introText: 'x'.repeat(2000), contactText: '' }).success).toBe(true);
    expect(CatalogueTextsInput.safeParse({ introText: 'x'.repeat(2001), contactText: '' }).success).toBe(false);
    expect(CatalogueTextsInput.safeParse({ introText: '', contactText: 'x'.repeat(2001) }).success).toBe(false);
  });

  it('[PUB-15] shows the current address to the admin, and asks before rotating, saying the old link stops working', async () => {
    const { action, confirm } = await submitRotate(false);
    expect(container.innerHTML).toContain(URL);
    expect(confirm).toHaveBeenCalledOnce();
    expect(String((confirm.mock.calls[0] as unknown[] | undefined)?.[0])).toContain('the old link stops working');
    expect(action).not.toHaveBeenCalled();
  });

  it('[PUB-15] rotates once confirmed and shows the new address', async () => {
    const { action } = await submitRotate(true);
    expect(action).toHaveBeenCalledOnce();
    expect(container.innerHTML).toContain('https://made-up.cloudfront.test/c/made-up-new/');
    expect(container.innerHTML).not.toContain(URL);
  });

  it('[PUB-15] says whether the old link still works when a rotation fails', () => {
    expect(renderToStaticMarkup(createElement(RotateOutcome, { result: { status: 'failed', requestId: 'req-1', previousKept: true } }))).toContain('The old link still works');
    expect(renderToStaticMarkup(createElement(RotateOutcome, { result: { status: 'failed', requestId: 'req-2', previousKept: false } }))).toContain('rotate again');
  });

  it('[PUB-9] [PUB-15] the stand-ins refuse anyone but the admin, and never claim to have saved or rotated', async () => {
    await expect(saveCatalogueTexts({} as AdminContext, { introText: '', contactText: '' })).rejects.toThrow(NotAdminError);
    await expect(rotateCatalogueToken({} as AdminContext)).rejects.toThrow(NotAdminError);
    expect(StandInError.name).toBe('StandInError');
  });
});
