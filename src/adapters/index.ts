/**
 * @file src/adapters/index.ts
 * Adapter registry. Default runs exercise every non-opt-in adapter; opt-in
 * capture-only agent adapters run only when explicitly selected via `--adapters`.
 */
import type { Adapter, AdapterName } from '../types.js';
import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';
import { inspectorAdapter } from './inspector.js';
import { mcpoAdapter } from './mcpo.js';

/** All known adapters, in default execution order. */
export const ADAPTERS: Record<AdapterName, Adapter> = {
  'claude-code': claudeCodeAdapter,
  codex: codexAdapter,
  inspector: inspectorAdapter,
  mcpo: mcpoAdapter,
};

/** Adapters exercised when `--adapters` is not given. */
export const DEFAULT_ADAPTERS: AdapterName[] = ['inspector', 'mcpo'];

export function isAdapterName(value: string): value is AdapterName {
  return value in ADAPTERS;
}
