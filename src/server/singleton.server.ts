/**
 * The process-wide RunManager.
 *
 * PINNED TO globalThis, AND THAT IS NOT OPTIONAL.
 *
 * In dev, React Router runs Vite in middleware mode and re-evaluates modules on
 * HMR. A plain module-scope `new RunManager()` would therefore be silently
 * recreated mid-run — losing the active run AND the single-flight lock while six
 * JVMs carry on in the background. The failure is silent, which is what makes it
 * dangerous. Pinning to globalThis is the standard fix in this lineage.
 */

import { loadSecrets } from "#core/env.server";
import { cooldownHoursFrom, DEFAULTS, resolveBatchConfig } from "#core/config.server";
import { RunManager } from "./run-manager.server.ts";
import { Store } from "./store.server.ts";

declare global {
  // eslint-disable-next-line no-var
  var __tcrsManager__: RunManager | undefined;
  // eslint-disable-next-line no-var
  var __tcrsManagerInit__: Promise<RunManager> | undefined;
}

function create(): RunManager {
  const config = resolveBatchConfig();
  const cooldown = cooldownHoursFrom();
  const store = new Store(config.dataDir, {
    successHours: cooldown.success,
    failedHours: cooldown.failed,
  });
  // loadSecrets() copies PASSWORD_* out of process.env and DELETES them, so under
  // Coolify (where they arrive as container env vars) no later crash dump or error
  // serialiser can spill them.
  const secrets = loadSecrets();
  return new RunManager({
    store,
    config,
    secrets,
    minFreeBytes: DEFAULTS.minFreeBytes,
  });
}

/** Get the manager, initialising it exactly once per process. */
export function getRunManager(): Promise<RunManager> {
  globalThis.__tcrsManagerInit__ ??= (async () => {
    const manager = (globalThis.__tcrsManager__ ??= create());
    try {
      await manager.init();
    } catch (e) {
      // Do NOT leave a permanently-rejected promise cached: a failed init (a held
      // lock, a transient fs error) must be retryable rather than poisoning every
      // later call for the life of the process.
      globalThis.__tcrsManagerInit__ = undefined;
      globalThis.__tcrsManager__ = undefined;
      throw e;
    }
    return manager;
  })();
  return globalThis.__tcrsManagerInit__;
}

/** The manager if it is already initialised, without triggering init. */
export function peekRunManager(): RunManager | undefined {
  return globalThis.__tcrsManager__;
}
