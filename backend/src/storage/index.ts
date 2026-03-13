import fs from "fs/promises";
import path from "path";
import { getSettingValue } from "../api/routes/settings.js";

/**
 * Resolve the output directory for a download.
 */
export function resolveOutputDir(
  pluginId: string,
  seriesTitle: string,
  volumeNum: number
): string {
  const basePath =
    getSettingValue<string>("download.basePath") ??
    path.join(process.cwd(), "data", "downloads");

  const sanitized = seriesTitle
    .replace(/[<>:"\/\\|?*]/g, "_")
    .replace(/\s+/g, "_")
    .substring(0, 100);

  const volDir = `vol_${String(volumeNum).padStart(3, "0")}`;

  return path.join(basePath, pluginId, sanitized, volDir);
}

/**
 * Ensure directory exists.
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
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
