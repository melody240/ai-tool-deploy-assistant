import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteCodeStore } from "./sqlite-store.js";

describe("SQLite code store", () => {
  it("persists codes, bindings, and audit records across restarts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "api-sqlite-test-"));
    const filePath = path.join(directory, "license.sqlite3");
    const code = {
      id: crypto.randomUUID(),
      codeHash: "a".repeat(64),
      prefix: "ADA-TEST",
      maxResets: 1,
      label: "Customer",
      batch: "batch-1"
    };
    const first = new SqliteCodeStore(filePath);
    await first.initialize();
    await first.create([code]);
    const activated = await first.activate(
      code.codeHash,
      crypto.randomUUID(),
      "b".repeat(64),
      "1.0.0"
    );
    await first.addAudit({
      id: crypto.randomUUID(),
      actor: "test",
      action: "test.persisted"
    });
    expect(activated.kind).toBe("activated");
    await first.close();

    const second = new SqliteCodeStore(filePath);
    await second.initialize();
    const listed = await second.list();
    const audit = await second.listAudit();
    expect(listed.total).toBe(1);
    expect(listed.codes[0]).toMatchObject({
      label: "Customer",
      batch: "batch-1",
      lastAppVersion: "1.0.0"
    });
    expect(audit[0]?.action).toBe("test.persisted");
    await second.close();
  });
});
