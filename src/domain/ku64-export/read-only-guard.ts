import { Ku64ExportError } from './types.js';

/**
 * Names of Drizzle executor methods that can mutate data. If any of these is even
 * *reached* on a guarded executor, we fail closed — the exporter must never write.
 */
const BLOCKED_METHODS = new Set([
  'insert',
  'update',
  'delete',
  'execute', // arbitrary SQL — not needed for whitelisted selects
]);

/**
 * Wrap a Drizzle executor (or any object) in a Proxy that throws the moment a
 * write-capable method is accessed. This is defense-in-depth on top of the
 * session-level `default_transaction_read_only=on` connection option: even a
 * mistaken repository wiring cannot issue INSERT/UPDATE/DELETE/DDL through it.
 *
 * `.select` and other read accessors pass through unchanged.
 */
export function readOnlyGuard<T extends object>(executor: T): T {
  return new Proxy(executor, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && BLOCKED_METHODS.has(prop)) {
        throw new Ku64ExportError('write_capable_method', `blocked write-capable executor method: ${prop}`);
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
    set() {
      throw new Ku64ExportError('write_capable_method', 'the read-only executor cannot be mutated');
    },
    deleteProperty() {
      throw new Ku64ExportError('write_capable_method', 'the read-only executor cannot be mutated');
    },
  });
}
