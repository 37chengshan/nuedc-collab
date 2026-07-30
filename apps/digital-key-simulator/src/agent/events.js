import { clone } from "./json.js";

export class AgentEventStream {
  constructor(options = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxEvents = options.maxEvents ?? 2000;
    this.sequence = 0;
    this.records = [];
    this.listeners = new Set();
  }

  emit(type, data = {}, options = {}) {
    const event = {
      seq: ++this.sequence,
      id: String(this.sequence),
      timestamp: this.now(),
      type,
      operationId: options.operationId ?? null,
      data: clone(data),
    };
    this.records.push(event);
    if (this.records.length > this.maxEvents) {
      this.records.splice(0, this.records.length - this.maxEvents);
    }
    for (const listener of this.listeners) {
      listener(clone(event));
    }
    return clone(event);
  }

  list(options = {}) {
    const after = Number(options.after ?? 0);
    const limit = Math.min(
      Math.max(Number(options.limit ?? 200) || 200, 1),
      2000,
    );
    return this.records
      .filter((event) => event.seq > after)
      .filter(
        (event) =>
          !options.operationId || event.operationId === options.operationId,
      )
      .filter((event) => !options.type || event.type === options.type)
      .slice(0, limit)
      .map(clone);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

