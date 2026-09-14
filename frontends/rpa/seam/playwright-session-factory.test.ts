import { describe, expect, it } from 'vitest';
import { resolveRpaBrowserExecutable } from './playwright-session-factory.js';

describe('RPA browser resolution', () => {
  it('prefers an explicit product browser path', () => {
    expect(resolveRpaBrowserExecutable('/managed/chrome', 'darwin', undefined, () => true)).toBe('/managed/chrome');
  });

  it('does not invent a browser executable on an unknown platform', () => {
    expect(resolveRpaBrowserExecutable('', 'unknown')).toBeUndefined();
  });

  it('uses a Playwright-managed browser when no system browser is installed', () => {
    expect(resolveRpaBrowserExecutable('', 'darwin', '/cache/playwright/chrome', (candidate) => candidate.startsWith('/cache/')))
      .toBe('/cache/playwright/chrome');
  });

  it('does not accept a stale explicit browser path', () => {
    expect(resolveRpaBrowserExecutable('/missing/chrome', 'darwin', undefined, () => false)).toBeUndefined();
  });
});
