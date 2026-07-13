import { describe, expect, it } from 'vitest';
import { guardRequest } from '../../src/integrations/capture/request-guard.js';

const opts = { blockTrackers: true, blockMedia: true };

describe('guardRequest', () => {
  it('allows a normal https resource', () => {
    expect(guardRequest('https://acme.example/style.css', 'stylesheet', opts).allow).toBe(true);
  });
  it('blocks non-http(s)', () => {
    expect(guardRequest('file:///etc/passwd', 'document', opts).allow).toBe(false);
    expect(guardRequest('ws://acme.example', 'websocket', opts).allow).toBe(false);
  });
  it('blocks credentials in URL', () => {
    expect(guardRequest('https://user:pass@acme.example', 'document', opts).allow).toBe(false);
  });
  it('blocks IP-literal in a private/metadata range', () => {
    expect(guardRequest('http://169.254.169.254/latest/meta-data', 'xhr', opts).allow).toBe(false);
    expect(guardRequest('http://127.0.0.1:8080/', 'document', opts).allow).toBe(false);
  });
  it('blocks trackers and media when configured', () => {
    expect(guardRequest('https://www.google-analytics.com/collect', 'script', opts).allow).toBe(false);
    expect(guardRequest('https://acme.example/video.mp4', 'media', opts).allow).toBe(false);
  });
  it('never blocks essential CSS/JS/images', () => {
    expect(guardRequest('https://acme.example/app.js', 'script', opts).allow).toBe(true);
    expect(guardRequest('https://acme.example/logo.png', 'image', opts).allow).toBe(true);
  });
});
