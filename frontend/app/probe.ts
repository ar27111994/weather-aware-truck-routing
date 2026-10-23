/** PROBE (throwaway, never merged): appends an entry to the page's probe log (`window.__probe`), if there is one. */
export function probe(type: string, data?: unknown): void {
  const log: unknown = Reflect.get(globalThis, "__probe");
  if (Array.isArray(log)) {
    log.push({ n: log.length, type: `app:${type}`, data: data === undefined ? null : JSON.stringify(data) });
  }
}
