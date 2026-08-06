// Covers QMD rows whose active path no longer exists on disk, against a real index.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { QmdDocumentResolver } from "./qmd-document-resolver.js";

const COLLECTION = "knowledge-workbench-main";
const HASH = "a1b2c3d4e5f6";
const REAL_RELATIVE = "rol/mundo_pathfinder.md";
const SLUG_RELATIVE = "rol/mundo-pathfinder.md";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function createIndexedWorkspace(): {
  db: DatabaseSync;
  collectionRoot: string;
  workspaceDir: string;
} {
  const workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-qmd-")));
  const collectionRoot = path.join(workspaceDir, "knowledge");
  fs.mkdirSync(path.join(collectionRoot, "rol"), { recursive: true });
  // Only the underscore file exists; the hyphenated slug is an index-only alias.
  fs.writeFileSync(path.join(collectionRoot, REAL_RELATIVE), "# Mundo de Pathfinder\n", "utf-8");

  const db = new DatabaseSync(path.join(workspaceDir, "index.sqlite"));
  db.exec(
    "CREATE TABLE documents (hash TEXT, collection TEXT, path TEXT, active INTEGER, modified_at INTEGER)",
  );
  const insert = db.prepare(
    "INSERT INTO documents (hash, collection, path, active, modified_at) VALUES (?, ?, ?, ?, ?)",
  );
  // The reported state: the real on-disk path is inactive, the slug alias is active.
  insert.run(HASH, COLLECTION, REAL_RELATIVE, 0, 1_752_000_000);
  insert.run(HASH, COLLECTION, SLUG_RELATIVE, 1, 1_752_000_000);
  cleanups.push(() => {
    db.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });
  return { db, collectionRoot, workspaceDir };
}

describe("QmdDocumentResolver active rows that are missing on disk", () => {
  it("does not resolve a citation to an active path that does not exist", async () => {
    const { db, collectionRoot, workspaceDir } = createIndexedWorkspace();
    const resolver = new QmdDocumentResolver(
      workspaceDir,
      new Map([[COLLECTION, { path: collectionRoot, kind: "workspace" as const }]]),
      () => db,
      true,
    );

    const location = await resolver.resolveDocLocation(HASH);

    if (!location) {
      throw new Error("expected a resolved doc location");
    }
    expect(fs.existsSync(location.abs)).toBe(true);
    expect(location.collectionRelativePath).toBe(REAL_RELATIVE);
  });
});
