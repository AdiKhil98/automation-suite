import { describe, expect, it } from 'vitest';
import {
  classifyHttpStatus,
  classifyInvalidRedirect,
  classifyNetworkError,
  classifyRedirectLimit,
} from '../../src/utils/network-error-classification.js';

describe('sanitized website verification error classification', () => {
  it.each([
    ['ENOTFOUND', 'DNS'],
    ['EAI_AGAIN', 'DNS'],
    ['UND_ERR_CONNECT_TIMEOUT', 'TIMEOUT'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'TLS'],
  ] as const)('classifies %s as %s', (code, stage) => {
    expect(classifyNetworkError(Object.assign(new Error('private detail'), { code }))).toEqual(
      expect.objectContaining({ errorCode: code, stage }),
    );
  });

  it('inspects nested causes and AggregateError children', () => {
    const child = Object.assign(new Error('child private detail'), { code: 'EAI_AGAIN' });
    const aggregate = new AggregateError([child], 'aggregate private detail');
    const outer = Object.assign(new Error('outer private detail'), { cause: aggregate });
    expect(classifyNetworkError(outer)).toEqual({ stage: 'DNS', errorCode: 'EAI_AGAIN', retryable: true });
  });

  it('classifies redirect exhaustion deterministically', () => {
    expect(classifyRedirectLimit()).toEqual({
      stage: 'REDIRECT',
      errorCode: 'TOO_MANY_REDIRECTS',
      retryable: false,
    });
  });

  it('classifies malformed redirect locations deterministically', () => {
    expect(classifyInvalidRedirect()).toEqual({
      stage: 'REDIRECT',
      errorCode: 'INVALID_REDIRECT_LOCATION',
      retryable: false,
    });
  });

  it.each([
    [404, 'INVALID', 'HTTP_4XX', false],
    [429, 'TRANSIENT', 'HTTP_429', true],
    [503, 'TRANSIENT', 'HTTP_5XX', true],
  ] as const)('classifies HTTP %s', (status, finalClassification, errorCode, retryable) => {
    expect(classifyHttpStatus(status)).toEqual({
      finalClassification,
      stage: 'HTTP',
      errorCode,
      retryable,
    });
  });
});
