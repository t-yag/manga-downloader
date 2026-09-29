import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { initDatabase } from "../src/db/init.js";

test("download filename keeps spaces in the author and title", async () => {
  process.env.DB_DIR = mkdtempSync(path.join(tmpdir(), "manga-downloader-storage-"));
  initDatabase();
  const { resolveOutputPath } = await import("../src/storage/index.js");

  const { outputDir, zipPath } = resolveOutputPath({
    plugin: "test",
    title: "Space Title",
    author: "Jane Doe",
    volume: 1,
  });

  assert.equal(path.basename(outputDir), "[Jane Doe] Space Title 第01巻");
  assert.equal(path.basename(zipPath), "[Jane Doe] Space Title 第01巻.zip");
});
