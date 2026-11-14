/** A tiny typed event emitter that works in Node and in the browser. */
export class Emitter<Events extends Record<string, unknown>> {
  private listeners: { [K in keyof Events]?: Set<(payload: Events[K]) => void> } = {}

  on<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): () => void {
    const set = (this.listeners[event] ??= new Set())
    set.add(fn)
    return () => set.delete(fn)
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    this.listeners[event]?.forEach((fn) => fn(payload))
  }
}
