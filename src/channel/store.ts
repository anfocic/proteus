import type { Message } from "../llm/types.ts";

export interface SessionStore {
  get(sessionId: string): Promise<Message[]>;
  append(sessionId: string, msgs: Message[]): Promise<void>;
}

export function inMemoryStore(): SessionStore {
  const data = new Map<string, Message[]>();
  const locks = new Map<string, Promise<void>>();

  return {
    async get(sessionId) {
      return [...(data.get(sessionId) ?? [])];
    },
    async append(sessionId, msgs) {
      const prev = locks.get(sessionId) ?? Promise.resolve();
      const next = prev.then(() => {
        const arr = data.get(sessionId) ?? [];
        arr.push(...msgs);
        data.set(sessionId, arr);
      });
      locks.set(
        sessionId,
        next.catch(() => undefined),
      );
      await next;
    },
  };
}
