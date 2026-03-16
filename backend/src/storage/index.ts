import fs from "fs/promises";
import path from "path";
import archiver from "archiver";
import { createWriteStream } from "fs";
import { getSettingValue } from "../api/routes/settings.js";
import { logger } from "../logger.js";

const log = logger.child({ module: "Storage" });

const DEFAULT_PATH_TEMPLATE = "{title}_{unit}_{volume}";

interface PathTemplateVars {
  plugin: string;
  title: string;
  volume: number;
  /** "vol" (default) or "ep" */
  unit?: string;
  author?: string;
  tags?: string[];
}

function sanitize(value: string): string {
  return value
    .replace(/[<>:"\/\\|?*]/g, "_")
    .replace(/\s+/g, "_")
    .substring(0, 100);
}

/**
 * Resolve the output path from a template string.
 * Variables: {plugin}, {title}, {volume}, {author}
 */
export function resolveOutputPath(vars: PathTemplateVars): {
  outputDir: string;
  zipPath: string;
} {
  const basePath =
    getSettingValue<string>("download.basePath") ??
    path.join(process.cwd(), "data", "downloads");

  const template =
    getSettingValue<string>("download.pathTemplate") ?? DEFAULT_PATH_TEMPLATE;

  const volStr = String(vars.volume).padStart(3, "0");

  const tagsStr = (vars.tags ?? []).join(" ");

  const unitStr = vars.unit ?? "vol";

  let resolved = template
    .replace(/\{plugin\}/g, sanitize(vars.plugin))
    .replace(/\{title\}/g, sanitize(vars.title))
    .replace(/\{volume\}/g, volStr)
    .replace(/\{unit\}/g, unitStr)
    .replace(/\{author\}/g, sanitize(vars.author ?? "unknown"))
    .replace(/\{tags\}/g, tagsStr ? sanitize(tagsStr) : "")
    .replace(/\{tags_comma\}/g, sanitize((vars.tags ?? []).join(",")));

  // Clean up trailing separators from empty variables
  resolved = resolved.replace(/[\s\-_]+$/g, "").replace(/\/[\s\-_]+\//g, "/");

  const fullPath = path.resolve(basePath, resolved);
  // The last segment becomes the zip filename
  const dirName = path.dirname(fullPath);
  const baseName = path.basename(fullPath);

  return {
    outputDir: fullPath,
    zipPath: path.join(dirName, `${baseName}.zip`),
  };
}

/**
 * Ensure directory exists.
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Zip a directory of page images and remove the source directory.
 * Returns the path to the created zip file.
 */
export async function zipAndCleanup(outputDir: string, zipPath: string): Promise<number> {
  await fs.mkdir(path.dirname(zipPath), { recursive: true });

  const fileSize = await new Promise<number>((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 0 } }); // store only, images are already compressed

    output.on("close", () => resolve(archive.pointer()));
    archive.on("error", reject);

    archive.pipe(output);
    archive.directory(outputDir, false);
    archive.finalize();
  });

  // Remove the source directory
  await fs.rm(outputDir, { recursive: true, force: true });
  log.info(`Created zip: ${zipPath} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`);

  return fileSize;
}

/**
 * Remove a previous download file and clean up empty parent directories
 * up to (but not including) basePath.
 */
export async function removeOldDownload(filePath: string): Promise<void> {
  const basePath = path.resolve(
    getSettingValue<string>("download.basePath") ??
      path.join(process.cwd(), "data", "downloads")
  );

  try {
    const stat = await fs.stat(filePath);
    if (stat.isFile()) {
      await fs.rm(filePath);
      log.info(`Removed old download: ${filePath}`);
    } else if (stat.isDirectory()) {
      await fs.rm(filePath, { recursive: true, force: true });
      log.info(`Removed old download dir: ${filePath}`);
    }
  } catch {
    return; // file doesn't exist, nothing to do
  }

  // Walk up and remove empty parent directories
  let dir = path.dirname(filePath);
  while (dir.length > basePath.length && dir.startsWith(basePath)) {
    try {
      const entries = await fs.readdir(dir);
      if (entries.length > 0) break;
      await fs.rmdir(dir);
      log.info(`Removed empty directory: ${dir}`);
      dir = path.dirname(dir);
    } catch {
      break;
    }
  }
}

/**
 * Get total size of files in a directory.
 */
export async function getDirSize(dirPath: string): Promise<number> {
  try {
    const entries = await fs.readdir(dirPath);
    let total = 0;
    for (const entry of entries) {
      const stat = await fs.stat(path.join(dirPath, entry));
      if (stat.isFile()) total += stat.size;
    }
    return total;
  } catch {
    return 0;
  }
}
