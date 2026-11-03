const handlers = new Map();
export const bus = {
  on(event, handler) {
    handlers.set(event, [...(handlers.get(event) ?? []), handler]);
  },
  emit(event, payload) {
    for (const h of handlers.get(event) ?? []) h(payload);
  },
  reset() { handlers.clear(); },
};
