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

/** Every known adapter, keyed by name; `--adapters` decides which run and in what order. */
export const ADAPTERS: Record<AdapterName, Adapter> = {
  'claude-code': claudeCodeAdapter,
  codex: codexAdapter,
  inspector: inspectorAdapter,
  mcpo: mcpoAdapter,
};

/** Adapters exercised when `--adapters` is not given. */
export const DEFAULT_ADAPTERS: AdapterName[] = ['inspector', 'mcpo'];

/** True only for a registry's own key — inherited names such as `toString` never qualify. */
export function isAdapterName(value: string): value is AdapterName {
  return Object.hasOwn(ADAPTERS, value);
}
