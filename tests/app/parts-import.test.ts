import { describe, expect, it } from 'vitest';
import { PARTS_PRESIGN_ENDPOINT, uploadAndImport, type PartsUploadDependencies } from '../../src/app/_admin/parts-import';
import type { ImportPartsResult } from '../../src/server/parts/parts';
import { en } from '../../src/app/messages/en';

/**
 * The parts file's import on `/admin/parts` (`src/app/_admin/parts-import.tsx`, #161): what the
 * owner is asked and told. The presign route and S3 are stand-ins.
 */

const file = new Blob(['<INVENTORY></INVENTORY>']);
const imported: ImportPartsResult = { status: 'imported', importId: 'made-up', format: 'BSX', lots: 3, quantity: 167, totalValue: null, currency: null, importedAt: '2026-11-02T10:00:00.000Z' };

function deps(overrides: Partial<PartsUploadDependencies> & { readonly asked?: string[]; readonly sent?: string[] } = {}): PartsUploadDependencies & { asked: string[]; sent: string[] } {
  const asked: string[] = overrides.asked ?? [];
  const sent: string[] = overrides.sent ?? [];
  return {
    asked,
    sent,
    online: () => true,
    confirm: (message) => {
      asked.push(message);
      return true;
    },
    fetch: (async (url: string) => {
      sent.push(String(url));
      if (url === PARTS_PRESIGN_ENDPOINT) return Response.json({ key: 'imports/made-up.xml', url: 'https://s3.example.test/', fields: { key: 'imports/made-up.xml' }, maxBytes: 1024 });
      return new Response(null, { status: 204 });
    }) as typeof fetch,
    importParts: async () => imported,
    ...overrides,
  };
}

describe('the import control', () => {
  it('[PARTS-4] warns before a second import that it replaces the current inventory, and does nothing when the owner declines', async () => {
    const first = deps();
    expect(await uploadAndImport(file, null, first)).toEqual({ kind: 'status', text: en.parts.imported(3, 167) });
    expect(first.asked).toEqual([]);

    const declined = deps({ confirm: () => false });
    expect(await uploadAndImport(file, 3, declined)).toEqual({ kind: 'status', text: '' });
    expect(declined.sent).toEqual([]);

    const second = deps();
    await uploadAndImport(file, 3, second);
    expect(second.asked).toEqual([en.parts.confirmReplace(3)]);
    expect(en.parts.confirmReplace(3)).toMatch(/Replace the current 3 lots/);
    expect(en.parts.replaceWarning).toMatch(/replaces the whole parts inventory/);
  });

  it('[PARTS-2] posts the file to the presigned URL, never to the admin, then imports by key; the import needs the network', async () => {
    const run = deps();
    let key = '';
    await uploadAndImport(file, null, { ...run, importParts: async (uploadKey) => ((key = uploadKey), imported) });
    expect(run.sent).toEqual([PARTS_PRESIGN_ENDPOINT, 'https://s3.example.test/']);
    expect(key).toBe('imports/made-up.xml');
    const offline = deps({ online: () => false });
    expect(await uploadAndImport(file, null, offline)).toEqual({ kind: 'alert', text: en.parts.needsNetwork });
    expect(offline.sent).toEqual([]);
    expect(await uploadAndImport(new Blob([new Uint8Array(2048)]), null, deps())).toEqual({ kind: 'alert', text: en.parts.tooLarge(1024) });
  });

  it('[PARTS-4] tells the owner why a file was refused, naming the lot, and that nothing changed', async () => {
    const refused = deps({ importParts: async () => ({ status: 'refused', code: 'invalid-lot', reason: 'the lot has no item number', lot: { index: 4 } }) });
    const outcome = await uploadAndImport(file, null, refused);
    expect(outcome.kind).toBe('alert');
    expect(outcome.text).toBe('The file was not imported, and nothing changed: lot 4: the lot has no item number.');
    expect(await uploadAndImport(file, null, deps({ importParts: async () => Promise.reject(new Error('made-up')) }))).toEqual({ kind: 'alert', text: en.parts.failed });
  });
});
