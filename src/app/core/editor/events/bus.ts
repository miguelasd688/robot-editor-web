export type Unsubscribe = () => void;

type AnyEvent = { type: string };

export class EventBus<E extends AnyEvent> {
  private listeners = new Map<string, Set<(event: E) => void>>();

  on<K extends E["type"]>(type: K, handler: (event: Extract<E, { type: K }>) => void): Unsubscribe {
    const key = String(type);
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    const set = this.listeners.get(key)!;
    const wrapped = handler as (event: E) => void;
    set.add(wrapped);

    return () => {
      set.delete(wrapped);
      if (set.size === 0) this.listeners.delete(key);
    };
  }

  emit(event: E) {
    const set = this.listeners.get(event.type);
    if (!set) return;
    for (const handler of set) {
      handler(event);
    }
  }
}
