import { describe, expect, it } from 'vitest';
import openNextConfig, { SERVER_WRAPPER } from '../../open-next.config';

/**
 * `[PLAT-16]` (#203): the admin's server function streams, so a page's loading screen reaches the
 * browser while the page waits for Aurora. OpenNext's `aws-lambda-streaming` wrapper marks the
 * server origin `streaming` in `.open-next/open-next.output.json`, from which `sst.aws.Nextjs`
 * sets the function URL's invoke mode to `RESPONSE_STREAM`: no other resource is involved.
 */
describe('the server function', () => {
  it('[PLAT-16] is built with the streaming wrapper and the converter it pairs with', () => {
    expect(SERVER_WRAPPER).toBe('aws-lambda-streaming');
    expect(openNextConfig.default.override).toEqual({ wrapper: 'aws-lambda-streaming' });
    // `aws-lambda-streaming` pairs only with OpenNext's default converter, `aws-apigw-v2`: none is set.
    expect('converter' in openNextConfig.default.override).toBe(false);
  });
});
