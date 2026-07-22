import { EventEmitter } from 'node:events';
import type { LookupAddress } from 'node:dns';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestMocks = vi.hoisted(() => ({
  http: vi.fn(),
  https: vi.fn(),
}));

vi.mock('node:http', () => ({ request: requestMocks.http }));
vi.mock('node:https', () => ({ request: requestMocks.https }));

import { safeGetHtml, type Resolver } from '../../src/utils/safe-fetch.js';

interface FakeResponseOptions {
  status?: number;
  headers?: Record<string, string>;
  chunks?: Buffer[];
}

class FakeResponse extends EventEmitter {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  destroyed = false;

  constructor(options: FakeResponseOptions = {}) {
    super();
    this.statusCode = options.status ?? 200;
    this.headers = options.headers ?? { 'content-type': 'text/html' };
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

class FakeRequest extends EventEmitter {
  constructor(private readonly onEnd: (request: FakeRequest) => void) {
    super();
  }

  end(): void {
    this.onEnd(this);
  }

  destroy(error?: Error): this {
    if (error) queueMicrotask(() => this.emit('error', error));
    return this;
  }
}

type RequestOptionsLike = {
  headers?: Record<string, string>;
  lookup?: (
    hostname: string,
    options: { all?: boolean },
    callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void,
  ) => void;
  servername?: string;
  timeout?: number;
};

type ResponseCallback = (response: FakeResponse) => void;

function installResponse(
  responseOptions: FakeResponseOptions = {},
  inspect?: (url: URL, options: RequestOptionsLike, addresses: LookupAddress[]) => void,
): void {
  requestMocks.https.mockImplementation(
    (input: URL, options: RequestOptionsLike, callback: ResponseCallback) =>
      new FakeRequest((request) => {
        const lookup = options.lookup;
        if (!lookup) throw new Error('safe lookup missing');
        lookup(input.hostname, { all: true }, (error, result) => {
          if (error) {
            request.emit('error', error);
            return;
          }
          const addresses = Array.isArray(result) ? result : [{ address: result, family: 4 }];
          inspect?.(input, options, addresses);
          const response = new FakeResponse(responseOptions);
          callback(response);
          queueMicrotask(() => {
            for (const chunk of responseOptions.chunks ?? [Buffer.from('<html>ok</html>')]) {
              if (!response.destroyed) response.emit('data', chunk);
            }
            if (!response.destroyed) response.emit('end');
          });
        });
      }),
  );
}

const opts = { timeoutMs: 1_000, maxRedirects: 2, maxBytes: 1_024 };

beforeEach(() => {
  requestMocks.http.mockReset();
  requestMocks.https.mockReset();
});

describe('safeGetHtml network controls', () => {
  it('supplies IPv6 and IPv4 so IPv4 can succeed after an IPv6 connection failure', async () => {
    const attempted: number[] = [];
    installResponse({}, (_url, _options, addresses) => {
      attempted.push(addresses[0]?.family ?? 0, addresses[1]?.family ?? 0);
    });
    const outcome = await safeGetHtml('https://fallback.example/', {
      ...opts,
      resolver: async () => ['2001:4860:4860::8888', '8.8.8.8'],
    });
    expect(attempted).toEqual([6, 4]);
    expect(outcome.kind).toBe('ok');
  });

  it.each([
    ['IPv4-only', ['8.8.8.8'], [4]],
    ['IPv6-only', ['2001:4860:4860::8888'], [6]],
  ] as const)('supports an %s host', async (_label, addresses, expectedFamilies) => {
    let families: number[] = [];
    installResponse({}, (_url, _options, approved) => {
      families = approved.map((entry) => entry.family);
    });
    const outcome = await safeGetHtml('https://single-family.example/', {
      ...opts,
      resolver: async () => [...addresses],
    });
    expect(families).toEqual(expectedFamilies);
    expect(outcome.kind).toBe('ok');
  });

  it('preserves the original Host header and TLS servername with a validated IP', async () => {
    installResponse({}, (url, options) => {
      expect(url.hostname).toBe('secure.example');
      expect(options.headers?.Host).toBe('secure.example');
      expect(options.servername).toBe('secure.example');
    });
    await expect(
      safeGetHtml('https://secure.example/', { ...opts, resolver: async () => ['8.8.8.8'] }),
    ).resolves.toMatchObject({ kind: 'ok' });
  });

  it('rejects a certificate hostname mismatch', async () => {
    requestMocks.https.mockImplementation(
      () =>
        new FakeRequest((request) => {
          request.emit(
            'error',
            Object.assign(new Error('private TLS detail'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }),
          );
        }),
    );
    const outcome = await safeGetHtml('https://tls.example/', {
      ...opts,
      resolver: async () => ['8.8.8.8'],
    });
    expect(outcome).toMatchObject({
      kind: 'transient',
      diagnostic: { failureStage: 'TLS', errorCode: 'ERR_TLS_CERT_ALTNAME_INVALID', retryable: false },
    });
  });

  it.each(['10.0.0.1', '127.0.0.1'])('blocks %s before opening a request', async (address) => {
    const outcome = await safeGetHtml('https://blocked.example/', {
      ...opts,
      resolver: async () => [address],
    });
    expect(outcome.kind).toBe('policy_blocked');
    expect(requestMocks.https).not.toHaveBeenCalled();
  });

  it('prevents DNS rebinding during connect-time re-resolution', async () => {
    let resolutions = 0;
    const resolver: Resolver = async () => (++resolutions === 1 ? ['8.8.8.8'] : ['127.0.0.1']);
    installResponse();
    const outcome = await safeGetHtml('https://rebind.example/', { ...opts, resolver });
    expect(resolutions).toBe(2);
    expect(outcome.kind).toBe('policy_blocked');
  });

  it('revalidates and blocks an unsafe redirect destination', async () => {
    installResponse({ status: 302, headers: { location: 'http://127.0.0.1/private' }, chunks: [] });
    const outcome = await safeGetHtml('https://redirect.example/', {
      ...opts,
      resolver: async () => ['8.8.8.8'],
    });
    expect(outcome.kind).toBe('policy_blocked');
    expect(requestMocks.https).toHaveBeenCalledTimes(1);
    expect(requestMocks.http).not.toHaveBeenCalled();
  });

  it('re-resolves and validates a hostname redirect before a second request', async () => {
    installResponse({
      status: 302,
      headers: { location: 'https://redirected.example/private' },
      chunks: [],
    });
    const resolver: Resolver = async (hostname) =>
      hostname === 'redirected.example' ? ['127.0.0.1'] : ['8.8.8.8'];
    const outcome = await safeGetHtml('https://origin.example/', { ...opts, resolver });
    expect(outcome.kind).toBe('policy_blocked');
    expect(requestMocks.https).toHaveBeenCalledTimes(1);
  });

  it('enforces the response-size limit', async () => {
    installResponse({ chunks: [Buffer.alloc(1_025)] });
    const outcome = await safeGetHtml('https://large.example/', {
      ...opts,
      resolver: async () => ['8.8.8.8'],
    });
    expect(outcome.kind).toBe('policy_blocked');
  });

  it('enforces the request timeout and preserves its sanitized code', async () => {
    requestMocks.https.mockImplementation(
      () =>
        new FakeRequest((request) => {
          request.emit('timeout');
        }),
    );
    const outcome = await safeGetHtml('https://timeout.example/', {
      ...opts,
      resolver: async () => ['8.8.8.8'],
    });
    expect(outcome).toMatchObject({
      kind: 'transient',
      diagnostic: { failureStage: 'TIMEOUT', errorCode: 'ETIMEDOUT', retryable: true },
    });
  });

  it.each(['ku64.de', 'zahnmedizin.charite.de', 'www.alldent-zahnzentrum-berlin.de'])(
    'regression: %s can use the Node all-address lookup contract',
    async (hostname) => {
      installResponse({}, (_url, _options, approved) => {
        expect(approved).toEqual([{ address: '8.8.8.8', family: 4 }]);
      });
      await expect(
        safeGetHtml(`https://${hostname}/`, { ...opts, resolver: async () => ['8.8.8.8'] }),
      ).resolves.toMatchObject({ kind: 'ok', status: 200 });
    },
  );
});
