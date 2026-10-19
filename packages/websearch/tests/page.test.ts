import { describe, expect, it, vi } from 'vitest';
import { createPageReader, isPublicAddress, parsePage } from '../src/page.js';

describe('public page reader', () => {
  it('retains the HTTP status so access denial is distinct from missing evidence', async () => {
    const read = createPageReader({
      resolve: () => Promise.resolve(['93.184.216.34']),
      request: () => Promise.resolve({ status: 403, type: 'text/html', body: 'Denied' }),
    });
    expect(await read({ url: 'https://clinic.test/' })).toMatchObject({
      status: 'unavailable',
      httpStatus: 403,
    });
  });
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '192.168.0.1',
    '100.64.0.1',
    '::1',
    '::ffff:127.0.0.1',
    '198.18.1.1',
    '224.1.1.1',
  ])('rejects non-public address %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
  it('rejects redirects into a private network before sending a second request', async () => {
    const request = vi.fn(() =>
      Promise.resolve({
        status: 302,
        location: 'https://internal.test/',
        type: 'text/html',
        body: '',
      }),
    );
    const read = createPageReader({
      resolve: (host) =>
        Promise.resolve(host === 'public.test' ? ['93.184.216.34'] : ['127.0.0.1']),
      request,
    });
    expect((await read({ url: 'https://public.test/' })).status).toBe('unavailable');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('pins a validated address and extracts useful deep-page text and official links', async () => {
    const request = vi.fn(() =>
      Promise.resolve({
        status: 200,
        type: 'text/html',
        body:
          '<title>Clinic</title><script>invented price</script>' +
          '<p>Background description.</p>'.repeat(500) +
          '<h2>Register online</h2><p>No proof of address required.</p><a href="/register?step=1&amp;lang=en">Start registration</a>',
      }),
    );
    const read = createPageReader({ resolve: () => Promise.resolve(['93.184.216.34']), request });
    const result = await read({ url: 'https://clinic.test/', find: 'Register online' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected page');
    expect(result.text).toContain('No proof of address');
    expect(result.text).not.toContain('invented price');
    expect(result.links[0]?.url).toBe('https://clinic.test/register?step=1&lang=en');
    expect(request.mock.calls[0]).toEqual([
      expect.any(URL),
      '93.184.216.34',
      expect.any(AbortSignal),
    ]);
  });
  it('rejects mixed public/private DNS and URLs with credentials without a request', async () => {
    const request = vi.fn();
    const read = createPageReader({
      resolve: () => Promise.resolve(['93.184.216.34', '10.0.0.1']),
      request,
    });
    expect((await read({ url: 'https://clinic.test/' })).status).toBe('unavailable');
    expect((await read({ url: 'https://u:p@clinic.test/' })).status).toBe('unavailable');
    expect(request).not.toHaveBeenCalled();
  });
  it('ignores script URLs, hidden code and non-text responses', async () => {
    const page = parsePage(
      '<style>hidden</style><a href="javascript:alert(1)">unsafe</a><p>Tickets £10</p>',
      new URL('https://clinic.test'),
    );
    expect(page.links).toEqual([]);
    expect(page.text).not.toContain('hidden');
    const read = createPageReader({
      resolve: () => Promise.resolve(['93.184.216.34']),
      request: () => Promise.resolve({ status: 200, type: 'application/pdf', body: 'pdf' }),
    });
    expect((await read({ url: 'https://clinic.test/' })).status).toBe('unavailable');
  });
});
