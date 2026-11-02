export interface BusPayload {
  total: number;
  orderId: string;
  discount?: number;
}
export type BusHandler = (payload: BusPayload) => void;
const handlers = new Map<string, BusHandler[]>();
export const bus = {
  on(event: string, handler: BusHandler): void {
    handlers.set(event, [...(handlers.get(event) ?? []), handler]);
  },
  emit(event: string, payload: BusPayload): void {
    for (const h of handlers.get(event) ?? []) h(payload);
  },
  reset(): void { handlers.clear(); },
};
