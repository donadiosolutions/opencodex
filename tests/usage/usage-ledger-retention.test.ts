import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { enforceUsageLedgerSizeLimit } from "../../src/usage/ledger-retention";
import { MIN_USAGE_LEDGER_MAX_BYTES } from "../../src/usage/retention-contract";
const previous = process.env.OPENCODEX_HOME;
let home: string | undefined;
afterEach(() => {
  if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
  if (home) removeTreeWithRetry(home);
});
test("a byte ceiling cannot delete accounting or shorten the seven-day detail window", () => {
  home = mkdtempSync(join(tmpdir(), "ocx-size-retention-"));
  process.env.OPENCODEX_HOME = home;
  const path = join(home, "usage.jsonl");
  const contents = `${JSON.stringify({ kind: "usage-rollup", retained: "x".repeat(MIN_USAGE_LEDGER_MAX_BYTES) })}\n${JSON.stringify({ requestId: "recent" })}\n`;
  writeFileSync(path, contents);
  expect(enforceUsageLedgerSizeLimit(undefined).kind).toBe("disabled");
  expect(enforceUsageLedgerSizeLimit(MIN_USAGE_LEDGER_MAX_BYTES)).toMatchObject({ kind: "deferred", reason: "accounting-required" });
  expect(readFileSync(path, "utf8")).toBe(contents);
});
