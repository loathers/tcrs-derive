/**
 * A tiny seq-stamping event bus. PURE: no `node:` imports (deliberately not
 * node:events, so this file stays importable by the browser bundle).
 *
 * The single writer of `seq`, monotonic from 1, used as the SSE `id:` and for
 * deterministic reducer tests.
 */

import type { RunEvent, RunEventInit } from "./events.ts";

export type Listener = (event: RunEvent) => void;

export interface Clock {
  now(): number;
}

export class EventBus {
  #seq = 0;
  #listeners = new Set<Listener>();
  readonly #clock: Clock;

  constructor(clock: Clock = Date) {
    this.#clock = clock;
  }

  get seq(): number {
    return this.#seq;
  }

  /** Stamp and publish. Returns the stamped event so callers can also persist it. */
  emit(init: RunEventInit): RunEvent {
    const event = {
      ...init,
      seq: ++this.#seq,
      at: this.#clock.now(),
    } as RunEvent;
    // Copy the listener set: a listener that unsubscribes during dispatch must not
    // perturb this iteration.
    for (const l of [...this.#listeners]) l(event);
    return event;
  }

  /** Subscribe; returns an unsubscribe function. */
  on(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
