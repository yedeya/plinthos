import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PublishOutcome } from '../../src/app/publish-form';
import type { PublishResult } from '../../src/server/publish/publish';

/** What the owner reads on `/admin` after a publish ([OPS-6], [PUB-8]). */
function outcome(result: PublishResult): string {
  return renderToStaticMarkup(createElement(PublishOutcome, { result }));
}

describe('the publish outcome on the page', () => {
  it('[PUB-8] says another publish is running when this one waited too long for its turn', () => {
    const html = outcome({ status: 'failed', requestId: 'req-busy', previousKept: true, busy: true });
    expect(html).toContain('Another publish is still running');
    expect(html).toContain('The previous catalogue is still online, unchanged.');
    expect(html).toContain('Reference: req-busy');
  });

  it('[OPS-6] names a failure that kept the previous catalogue without blaming another publish', () => {
    const html = outcome({ status: 'failed', requestId: 'req-kept', previousKept: true });
    expect(html).not.toContain('Another publish');
    expect(html).toContain('The previous catalogue is still online, unchanged.');
    expect(html).toContain('Reference: req-kept');
  });

  it('[OPS-6] says to publish again when the catalogue may be partly updated', () => {
    const html = outcome({ status: 'failed', requestId: 'req-partial', previousKept: false });
    expect(html).toContain('The catalogue may be partly updated: publish again.');
    expect(html).not.toContain('still online');
    expect(html).toContain('Reference: req-partial');
  });
});
