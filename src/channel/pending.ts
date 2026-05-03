import type { SuspensionPayload } from "../agent/run.ts";

export interface PendingRecord {
  routedTo: string;
  suspended: SuspensionPayload;
}

export interface PendingStore {
  get(sessionId: string): Promise<PendingRecord | undefined>;
  set(sessionId: string, record: PendingRecord): Promise<void>;
  clear(sessionId: string): Promise<void>;
}

export function inMemoryPendingStore(): PendingStore {
  const data = new Map<string, PendingRecord>();
  return {
    async get(sessionId) {
      return data.get(sessionId);
    },
    async set(sessionId, record) {
      data.set(sessionId, record);
    },
    async clear(sessionId) {
      data.delete(sessionId);
    },
  };
}
