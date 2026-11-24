import { describe, expect, it } from "vitest";
import { park, until } from "../test/fixtures";
import { Queue } from "./files";

describe("Queue", () => {
  // Wrong: coalescing ordinary jobs drops an operation and gives two callers the same result.
  it("runs each distinct waiting job in order", async () => {
    const queue = new Queue();
    const order: string[] = [];
    const actions = {
      async save(name: string) {
        order.push(name);
        return `saved ${name}`;
      },
    };
    const firstGate = park(actions, "save");
    try {
      const first = queue.run(() => actions.save("first"));
      expect(await until(() => firstGate.parked >= 1)).toBe(true);
      const second = queue.run(() => actions.save("second"));
      const third = queue.run(() => actions.save("third"));
      firstGate.open();
      expect(await Promise.all([first, second, third])).toEqual(["saved first", "saved second", "saved third"]);
      expect(order).toEqual(["first", "second", "third"]);
    } finally {
      firstGate.open();
    }
  });
});
