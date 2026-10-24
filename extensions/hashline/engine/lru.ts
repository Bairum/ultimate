/** Size- and entry-bounded LRU used by the snapshot store. */
export class LRUCache<K, V> {
  readonly #entries = new Map<K, V>()
  readonly #options: { max: number; maxSize: number; sizeCalculation: (value: V) => number }
  constructor(options: { max: number; maxSize: number; sizeCalculation: (value: V) => number }) {
    this.#options = options
  }
  get(key: K): V | undefined {
    const value = this.#entries.get(key)
    if (value !== undefined) {
      this.#entries.delete(key)
      this.#entries.set(key, value)
    }
    return value
  }
  set(key: K, value: V): void {
    this.#entries.delete(key)
    this.#entries.set(key, value)
    let size = 0
    for (const entry of this.#entries.values()) size += this.#options.sizeCalculation(entry)
    while (this.#entries.size > this.#options.max || size > this.#options.maxSize) {
      const oldest = this.#entries.entries().next()
      if (oldest.done) break
      size -= this.#options.sizeCalculation(oldest.value[1])
      this.#entries.delete(oldest.value[0])
    }
  }
  values(): MapIterator<V> {
    return this.#entries.values()
  }
  delete(key: K): void {
    this.#entries.delete(key)
  }
  clear(): void {
    this.#entries.clear()
  }
}
