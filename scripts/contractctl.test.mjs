import assert from "node:assert/strict";
import test from "node:test";

import { main } from "./contractctl.mjs";

function io() {
  const out = [];
  const err = [];
  return { out, err, value: { out: (line) => out.push(line), err: (line) => err.push(line) } };
}

test("help exposes only validation, consumer preparation/sync, and read-only status", async () => {
  const sink = io();
  assert.equal(await main(["--help"], { io: sink.value, runner: {}, github: {} }), 0);
  const text = sink.out.join("\n");
  assert.match(text, /consumers <prepare\|sync>/);
  assert.match(text, /status/);
  assert.doesNotMatch(text, /merge|deploy|continue|resume|confirm/i);
});

test("removed controller actions are unknown and perform no calls", async () => {
  const sink = io();
  const calls = [];
  const runner = new Proxy({}, { get: () => (...args) => calls.push(args) });
  assert.equal(await main(["rollout", "continue", "https://github.com/cdotlock/lunascripts/pull/2"], { io: sink.value, runner, github: {} }), 1);
  assert.deepEqual(calls, []);
  assert.match(sink.err[0], /unknown/);
});
