import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { FileJournal, MemoryJournal } from "../src/journal.js";

// 2026-11-27 14:30 UTC = 09:30 New York.
const T0 = Date.parse("2026-11-27T14:30:00.000Z");
const ACCESS = "0123456789abcdef".repeat(4);
const FEED = "feed-token-9f8e7d6c5b4a";

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tws-bridge-journal-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fileText(journal: FileJournal): string {
  return fs.readFileSync(journal.fileFor("2026-11-27"), "utf8");
}

test("FileJournal: a secret added later is replaced in every line written after it", (t) => {
  const journal = new FileJournal(tempDir(t), () => T0, [ACCESS]);
  journal.write("before", { token: FEED, access: ACCESS });
  journal.addSecret(FEED);
  journal.write("after", { token: FEED, nested: { list: [`Bearer ${FEED}`] }, [FEED]: 1 });
  journal.writeOrThrow("after_throwing", { why: `refused ${FEED}` });

  const [before, after, throwing] = journal.readDay("2026-11-27");
  // A line written before the secret was known is not rewritten: only the access token is gone.
  assert.equal(before?.["token"], FEED);
  assert.equal(before?.["access"], "[redacted]");
  assert.deepEqual(after, { t: "2026-11-27T14:30:00.000Z", type: "after", token: "[redacted]", nested: { list: ["Bearer [redacted]"] }, "[redacted]": 1 });
  assert.equal(throwing?.["why"], "refused [redacted]");
  assert.equal(fileText(journal).split("\n").slice(1).join("\n").includes(FEED), false);
});

test("FileJournal: short secrets are ignored and a secret added twice is replaced once", (t) => {
  const journal = new FileJournal(tempDir(t), () => T0, []);
  journal.addSecret("short");
  journal.addSecret("");
  journal.addSecret(FEED);
  journal.addSecret(FEED);
  journal.write("x", { a: "short words stay", b: FEED });
  assert.deepEqual(journal.readDay("2026-11-27")[0], { t: "2026-11-27T14:30:00.000Z", type: "x", a: "short words stay", b: "[redacted]" });
});

test("FileJournal: a secret that contains another one is replaced whole", (t) => {
  const inner = "abcdefgh";
  const outer = "abcdefgh12345678";
  const journal = new FileJournal(tempDir(t), () => T0, [inner]);
  journal.addSecret(outer);
  journal.write("x", { a: outer, b: inner });
  assert.deepEqual(journal.readDay("2026-11-27")[0], { t: "2026-11-27T14:30:00.000Z", type: "x", a: "[redacted]", b: "[redacted]" });
  assert.equal(fileText(journal).includes("12345678"), false);
});

test("MemoryJournal: with no secret the lines are kept as given", () => {
  const journal = new MemoryJournal();
  const nested = { qty: 100, price: 1.25, flag: true, none: null };
  journal.write("order", { nested, missing: undefined });
  journal.writeOrThrow("sent", { id: 7 });
  assert.deepEqual(journal.events, [{ type: "order", nested, missing: undefined }, { type: "sent", id: 7 }]);
  // The same object, as before: nothing is copied when there is nothing to replace.
  assert.equal(journal.events[0]?.["nested"], nested);
  assert.deepEqual(journal.ofType("sent"), [{ type: "sent", id: 7 }]);
  assert.deepEqual(journal.readDay(), []);
});

test("MemoryJournal: secrets are replaced in strings, nested ones and keys included; other values kept", () => {
  const journal = new MemoryJournal([ACCESS, "tiny"]);
  journal.addSecret(FEED);
  journal.addSecret("short");
  const when = new Date(T0);
  journal.write("feed_paired", {
    server: "https://pnldash.uz",
    token: FEED,
    headers: { authorization: `Bearer ${FEED}`, list: [ACCESS, 3, null, { deep: FEED }] },
    [FEED]: "as a key",
    qty: 100,
    ok: false,
    when,
    note: "tiny short words stay",
  });
  assert.equal(JSON.stringify(journal.events).includes(FEED), false);
  assert.equal(JSON.stringify(journal.events).includes(ACCESS), false);
  assert.deepEqual(journal.events[0], {
    type: "feed_paired",
    server: "https://pnldash.uz",
    token: "[redacted]",
    headers: { authorization: "Bearer [redacted]", list: ["[redacted]", 3, null, { deep: "[redacted]" }] },
    "[redacted]": "as a key",
    qty: 100,
    ok: false,
    when,
    note: "tiny short words stay",
  });
  assert.equal(journal.events[0]?.["when"], when);
});

test("MemoryJournal: writeOrThrow redacts too, and failWrites still fails without keeping the line", () => {
  const journal = new MemoryJournal();
  journal.addSecret(FEED);
  journal.writeOrThrow("x", { token: FEED });
  assert.deepEqual(journal.events, [{ type: "x", token: "[redacted]" }]);
  journal.failWrites = true;
  assert.throws(() => journal.writeOrThrow("y", { token: FEED }), /disk full/);
  assert.equal(journal.events.length, 1);
  // `write` never throws, as before.
  journal.write("z", { token: FEED });
  assert.deepEqual(journal.events[1], { type: "z", token: "[redacted]" });
});
