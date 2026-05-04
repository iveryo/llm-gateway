export type QueueRunResult<T> = {
  value: T;
  waitMs: number;
};

type QueueTask<T> = {
  enqueuedAt: number;
  resolve: (result: QueueRunResult<T>) => void;
  reject: (error: unknown) => void;
  run: () => Promise<T>;
};

export class RequestQueue {
  private active = 0;
  private readonly pending: QueueTask<unknown>[] = [];
  private concurrency?: number;

  constructor(concurrency?: number) {
    this.setConcurrency(concurrency);
  }

  setConcurrency(concurrency?: number): void {
    this.concurrency = normalizeConcurrency(concurrency);
    this.drain();
  }

  run<T>(run: () => Promise<T>): Promise<QueueRunResult<T>> {
    return new Promise<QueueRunResult<T>>((resolve, reject) => {
      this.pending.push({
        enqueuedAt: Date.now(),
        resolve: resolve as (result: QueueRunResult<unknown>) => void,
        reject,
        run
      });
      this.drain();
    });
  }

  private drain(): void {
    while (this.hasCapacity() && this.pending.length > 0) {
      const task = this.pending.shift()!;
      this.active += 1;
      const waitMs = Date.now() - task.enqueuedAt;
      void task.run()
        .then((value) => task.resolve({ value, waitMs }))
        .catch(task.reject)
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }

  private hasCapacity(): boolean {
    return this.concurrency === undefined || this.active < this.concurrency;
  }
}

function normalizeConcurrency(concurrency?: number): number | undefined {
  const value = Math.floor(Number(concurrency) || 0);
  return value > 0 ? value : undefined;
}
