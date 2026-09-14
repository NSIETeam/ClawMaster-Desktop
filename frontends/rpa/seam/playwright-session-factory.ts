/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import type { RpaWebPage, RpaWebSession, RpaWebSessionFactory } from './web-driver.js';
import { existsSync } from 'node:fs';

interface PlaywrightContext {
  newPage(): Promise<RpaWebPage>;
  close(): Promise<void>;
}

interface PlaywrightBrowser {
  newContext(): Promise<PlaywrightContext>;
  close(): Promise<void>;
}

interface PlaywrightModule {
  chromium?: {
    launch(options: { headless: boolean; executablePath?: string }): Promise<PlaywrightBrowser>;
    executablePath(): string;
  };
}

export interface PlaywrightSessionOptions {
  /** Explicit browser path for an isolated deployment or controlled E2E run. */
  executablePath?: string;
}

export function resolveRpaBrowserExecutable(
  explicit = process.env['CLAWMASTER_RPA_BROWSER_EXECUTABLE']
    ?? process.env['CLAWMASTER_RPA_BROWSER_EXECUTABLE'],
  platform: string = process.platform,
  managedExecutable?: string,
  pathExists: (candidate: string) => boolean = existsSync,
): string | undefined {
  if (explicit?.trim()) return pathExists(explicit.trim()) ? explicit.trim() : undefined;
  const candidates = platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ]
      : platform === 'win32'
      ? [
          `${process.env['PROGRAMFILES'] ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env['PROGRAMFILES'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
          `${process.env['PROGRAMFILES(X86)'] ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env['PROGRAMFILES(X86)'] ?? ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
          `${process.env['LOCALAPPDATA'] ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((candidate) => candidate && pathExists(candidate))
    ?? (managedExecutable && pathExists(managedExecutable) ? managedExecutable : undefined);
}

/** Runtime Playwright Core adapter. It is optional so Core does not bundle a browser. */
export class PlaywrightWebSessionFactory implements RpaWebSessionFactory {
  constructor(private readonly options: PlaywrightSessionOptions = {}) {}

  async create(): Promise<RpaWebSession> {
    let module: PlaywrightModule;
    try {
      module = (await import('playwright-core')) as unknown as PlaywrightModule;
    } catch {
      throw new Error('RPA Web Driver requires the optional "playwright-core" package.');
    }
    if (!module.chromium) {
      throw new Error('RPA Web Driver requires the optional "playwright-core" package.');
    }
    const executablePath = resolveRpaBrowserExecutable(
      this.options.executablePath,
      process.platform,
      module.chromium.executablePath(),
    );
    if (!executablePath) {
      throw new Error('ClawMaster RPA 需要 Chrome、Edge、Chromium，或已安装的 Playwright 浏览器运行环境。');
    }
    const browser = await module.chromium.launch({ headless: true, executablePath });
    const context = await browser.newContext();
    const page = await context.newPage();
    return {
      page,
      async close(): Promise<void> {
        await context.close();
        await browser.close();
      },
    };
  }
}
