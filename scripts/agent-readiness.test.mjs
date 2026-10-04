import assert from "node:assert/strict";
import { waitForAgentContext } from "../dist/agentReadiness.js";

const responses = [
  new Response("partial", { headers: { "x-clipy-agent-readiness": "preparing", "retry-after": "1" } }),
  new Response("usable", { headers: { "x-clipy-agent-readiness": "usable" } }),
];
const delays = [];
const result = await waitForAgentContext(
  async () => responses.shift(),
  { timeoutMs: 5_000, now: () => 0, sleep: async (ms) => delays.push(ms) },
);

assert.equal(await result.response.text(), "usable");
assert.equal(result.timedOut, false);
assert.deepEqual(delays, [1_000]);

let clock = 0;
let timeoutCalls = 0;
const timeoutResult = await waitForAgentContext(
  async () => {
    timeoutCalls += 1;
    return new Response("partial", {
      headers: { "x-clipy-agent-readiness": "preparing", "retry-after": "3" },
    });
  },
  {
    timeoutMs: 2_500,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  },
);
assert.equal(timeoutResult.timedOut, true);
assert.equal(timeoutCalls, 1);

let slowCalls = 0;
const slowStartedAt = Date.now();
const slowResult = await waitForAgentContext(
  async (signal) => {
    slowCalls += 1;
    if (slowCalls === 1) {
      return new Response("latest partial", {
        headers: { "x-clipy-agent-readiness": "preparing" },
      });
    }
    await new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  },
  { timeoutMs: 30, now: Date.now, sleep: async () => undefined },
);
assert.equal(slowResult.timedOut, true);
assert.equal(slowCalls, 2);
assert.equal(await slowResult.response.text(), "latest partial");
assert.ok(Date.now() - slowStartedAt < 250);
console.log("agent readiness wait tests passed");
