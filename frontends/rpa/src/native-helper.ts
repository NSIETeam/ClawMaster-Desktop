/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

// Bridge from the DSH host half to the recovered native helper.
//
// The recovered control plane is a command-line program: `<helper> --native-tool
// <name> [args...]` prints JSON on stdout and, on failure, a human-readable
// reason on stderr with exit code 2. This module owns invocation only. It does
// not inspect or rewrite payloads, and it never composes a coordinate: the
// recovered contract keeps raw input and element resolution inside the helper.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** How to launch the helper. Tests inject a stand-in command. */
export interface NativeHelperSpec {
  command: string;
  args: readonly string[];
}

export interface NativeHelperConfig {
  helper?: NativeHelperSpec;
  timeoutMs?: number;
}

/** A failed native invocation, carrying the helper's own reason text. */
export class NativeHelperError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = 'NativeHelperError';
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Locate the helper next to this component.
 *
 * @returns The release binary if present, otherwise the debug binary, otherwise null.
 */
export function defaultHelperPath(): string | null {
  for (const profile of ['release', 'debug']) {
    const candidate = path.resolve(HERE, '..', 'native', 'target', profile, 'clawmaster-rpa-native');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve the helper launch spec.
 *
 * @param configured Operator-supplied spec, which wins over detection.
 * @returns The spec to use, or null when no helper has been built.
 */
export function resolveHelperSpec(configured?: NativeHelperSpec): NativeHelperSpec | null {
  if (configured) return configured;
  const detected = defaultHelperPath();
  return detected ? { command: detected, args: [] } : null;
}

export interface NativeHelper {
  readonly spec: NativeHelperSpec;
  /**
   * Invoke one native subcommand.
   *
   * @param command The `--native-tool` name.
   * @param args Positional arguments after the subcommand.
   * @param signal Cancels the child when it fires.
   * @returns The parsed JSON payload printed on stdout.
   */
  run(command: string, args?: readonly string[], signal?: AbortSignal): Promise<unknown>;
}

/**
 * Build a helper client.
 *
 * @param spec How to launch the helper.
 * @param timeoutMs Wall-clock bound for one invocation.
 * @returns A client whose `run` resolves to the parsed stdout payload.
 */
export function createNativeHelper(spec: NativeHelperSpec, timeoutMs = 30_000): NativeHelper {
  return {
    spec,
    run(command, args = [], signal) {
      return new Promise<unknown>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new NativeHelperError('Native invocation was cancelled before it started.', command, null));
          return;
        }

        const child = spawn(spec.command, [...spec.args, '--native-tool', command, ...args], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (error: Error | null, value?: unknown): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          if (error) reject(error);
          else resolve(value);
        };

        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          finish(new NativeHelperError(`Native invocation timed out after ${timeoutMs}ms: ${command}`, command, null));
        }, timeoutMs);

        const onAbort = (): void => {
          child.kill('SIGKILL');
          finish(new NativeHelperError(`Native invocation was cancelled: ${command}`, command, null));
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        child.stdout.on('data', (chunk) => {
          stdout += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });

        child.on('error', (error) => {
          finish(new NativeHelperError(`Native helper could not start: ${error.message}`, command, null));
        });

        child.on('close', (code) => {
          const message = stderr.trim();
          if (code !== 0) {
            finish(new NativeHelperError(message || `Native helper exited with code ${String(code)}.`, command, code));
            return;
          }
          try {
            finish(null, JSON.parse(stdout) as unknown);
          } catch {
            finish(new NativeHelperError('Native helper returned a payload that is not JSON.', command, code));
          }
        });
      });
    },
  };
}
