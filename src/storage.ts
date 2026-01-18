import { exists, readTextFile, writeTextFile, mkdir } from "@tauri-apps/plugin-fs";
import { appDataDir, join, resourceDir } from "@tauri-apps/api/path";
import type { Target } from "./types";

const FILE_NAME = "targets.json";

export type StorageMode = "portable" | "appdata";

let cachedMode: StorageMode | null = null;
let cachedPath: string | null = null;

async function detectStorageMode(): Promise<{ mode: StorageMode; path: string }> {
  if (cachedMode && cachedPath) {
    return { mode: cachedMode, path: cachedPath };
  }

  // Check for portable mode (targets.json next to exe)
  try {
    const exeDir = await resourceDir();
    const portablePath = await join(exeDir, FILE_NAME);
    if (await exists(portablePath)) {
      cachedMode = "portable";
      cachedPath = portablePath;
      return { mode: "portable", path: portablePath };
    }
  } catch {
    // resourceDir may not be available in dev mode
  }

  // Fall back to AppData
  const dir = await appDataDir();
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    // Directory might already exist
  }
  const appDataPath = await join(dir, FILE_NAME);
  cachedMode = "appdata";
  cachedPath = appDataPath;
  return { mode: "appdata", path: appDataPath };
}

export async function getStorageInfo(): Promise<{ mode: StorageMode; path: string }> {
  return detectStorageMode();
}

const DEFAULT_TARGETS: Target[] = [];

export async function loadTargets(): Promise<Target[]> {
  try {
    const { path } = await detectStorageMode();
    if (!(await exists(path))) {
      // First time running - save and return default targets
      await writeTextFile(path, JSON.stringify(DEFAULT_TARGETS, null, 2));
      return DEFAULT_TARGETS;
    }
    const txt = await readTextFile(path);
    const targets = JSON.parse(txt) as Target[];
    // If file exists but is empty array, return defaults
    if (targets.length === 0) {
      await writeTextFile(path, JSON.stringify(DEFAULT_TARGETS, null, 2));
      return DEFAULT_TARGETS;
    }
    return targets;
  } catch (e) {
    console.error("Failed to load targets:", e);
    return DEFAULT_TARGETS;
  }
}

export async function saveTargets(targets: Target[]): Promise<void> {
  try {
    const { path } = await detectStorageMode();
    await writeTextFile(path, JSON.stringify(targets, null, 2));
  } catch (e) {
    console.error("Failed to save targets:", e);
  }
}

export function parseTargetsJson(text: string): Target[] | null {
  try {
    const data = JSON.parse(text);
    if (!Array.isArray(data)) return null;
    return data.filter(
      (t) =>
        typeof t.id === "string" &&
        typeof t.name === "string" &&
        typeof t.host === "string" &&
        typeof t.port === "number"
    );
  } catch {
    return null;
  }
}
