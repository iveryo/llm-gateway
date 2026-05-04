import { describe, expect, it } from "vitest";
import { RequestQueue } from "./requestQueue.js";

describe("RequestQueue", () => {
  it("runs provider calls one at a time when concurrency is 1", async () => {
    const queue = new RequestQueue(1);
    const events: string[] = [];

    const first = queue.run(async () => {
      events.push("first:start");
      await delay(20);
      events.push("first:end");
      return "first";
    });
    const second = queue.run(async () => {
      events.push("second:start");
      events.push("second:end");
      return "second";
    });

    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("allows concurrent provider calls up to the configured limit", async () => {
    const queue = new RequestQueue(2);
    let active = 0;
    let maxActive = 0;

    await Promise.all(
      [1, 2, 3].map((value) =>
        queue.run(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await delay(10);
          active -= 1;
          return value;
        })
      )
    );

    expect(maxActive).toBe(2);
  });

  it("does not limit provider calls when concurrency is not configured", async () => {
    const queue = new RequestQueue();
    const maxActive = await runAndTrackMaxActive(queue);

    expect(maxActive).toBe(3);
  });

  it("does not limit provider calls when concurrency is 0", async () => {
    const queue = new RequestQueue(0);
    const maxActive = await runAndTrackMaxActive(queue);

    expect(maxActive).toBe(3);
  });
});

async function runAndTrackMaxActive(queue: RequestQueue): Promise<number> {
  let active = 0;
  let maxActive = 0;

  await Promise.all(
    [1, 2, 3].map((value) =>
      queue.run(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(10);
        active -= 1;
        return value;
      })
    )
  );

  return maxActive;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
