import { createHash } from "node:crypto";

type Entry = { fingerprint: string; expires: number; result: Promise<unknown>; pending: boolean; };

export class RequestCache {
  private readonly entries = new Map<string, Entry>();

  async run<T>(key: string | undefined, body: string, work: () => Promise<T>): Promise<T> {
    if (!key) return work();
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (!entry.pending && entry.expires < now) this.entries.delete(id);
    }
    const fingerprint = createHash("sha256").update(body).digest("hex");
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("같은 요청 식별자로 다른 내용을 보낼 수 없습니다.");
      return existing.result as Promise<T>;
    }
    if (this.entries.size >= 256) {
      const completed = [...this.entries].find(([, entry]) => !entry.pending);
      if (completed) this.entries.delete(completed[0]);
      else throw new Error("처리 중인 요청이 너무 많습니다.");
    }
    const result = Promise.resolve().then(work);
    const entry: Entry = { fingerprint, expires: now + 600_000, result, pending: true };
    this.entries.set(key, entry);
    try {
      return await result;
    } catch (error) {
      this.entries.delete(key);
      throw error;
    } finally {
      entry.pending = false;
    }
  }
}
