import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import type { Target, ProbeResult, TargetStats } from "./types";
import { loadTargets, saveTargets, parseTargetsJson, getStorageInfo, StorageMode } from "./storage";

const WINDOW_MS = 5 * 60 * 1000; // 5 minute rolling window

function quantile(arr: number[], q: number): number | null {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function computeHealth(
  successRate: number | null,
  average: number | null,
  p90: number | null
): TargetStats["health"] {
  if (successRate === null) return "unknown";
  if (successRate >= 0.995 && average !== null && average <= 15 && p90 !== null && p90 <= 30) return "optimal";
  if (successRate >= 0.99 && average !== null && average <= 30 && p90 !== null && p90 <= 80) return "great";
  if (successRate >= 0.98 && (average === null || average <= 80) && (p90 === null || p90 <= 200)) return "good";
  if (successRate >= 0.95) return "warn";
  if (successRate >= 0.70) return "bad";
  return "down";
}

function generateId(): string {
  return crypto.randomUUID();
}

export default function App() {
  const [targets, setTargets] = useState<Target[]>([]);
  const [results, setResults] = useState<Map<string, ProbeResult[]>>(new Map());
  const [editingTarget, setEditingTarget] = useState<Target | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [storageMode, setStorageMode] = useState<StorageMode>("appdata");
  const [storagePath, setStoragePath] = useState<string>("");
  const [showInfo, setShowInfo] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load targets and storage info on mount
  useEffect(() => {
    (async () => {
      const info = await getStorageInfo();
      setStorageMode(info.mode);
      setStoragePath(info.path);
      const loaded = await loadTargets();
      setTargets(loaded);
      await invoke("set_targets", { targets: loaded });
    })();
  }, []);

  // Listen for probe updates
  useEffect(() => {
    const unlisten = listen<ProbeResult>("probe:update", (event) => {
      const result = event.payload;
      setResults((prev) => {
        const next = new Map(prev);
        const arr = next.get(result.id) || [];
        arr.push(result);
        // Prune old results
        const cutoff = Date.now() - WINDOW_MS;
        const pruned = arr.filter((r) => r.timestamp >= cutoff);
        next.set(result.id, pruned);
        return next;
      });
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Listen for drag-drop
  useEffect(() => {
    const unlistenDrop = listen<{ paths: string[] }>("tauri://drag-drop", async (event) => {
      setDragOver(false);
      const paths = event.payload.paths || [];
      const jsonPath = paths.find((p) => p.toLowerCase().endsWith(".json"));
      if (!jsonPath) return;

      try {
        const txt = await readTextFile(jsonPath);
        const imported = parseTargetsJson(txt);
        if (imported && imported.length > 0) {
          setTargets(imported);
          await saveTargets(imported);
          await invoke("set_targets", { targets: imported });
          setResults(new Map());
        }
      } catch (e) {
        console.error("Failed to import:", e);
      }
    });

    const unlistenEnter = listen("tauri://drag-enter", () => setDragOver(true));
    const unlistenLeave = listen("tauri://drag-leave", () => setDragOver(false));

    return () => {
      unlistenDrop.then((fn) => fn());
      unlistenEnter.then((fn) => fn());
      unlistenLeave.then((fn) => fn());
    };
  }, []);

  const handleSaveTargets = useCallback(async (newTargets: Target[]) => {
    setTargets(newTargets);
    await saveTargets(newTargets);
    await invoke("set_targets", { targets: newTargets });
  }, []);

  const handleAddTarget = () => {
    setEditingTarget({ id: generateId(), name: "", host: "", port: 11000 });
    setIsAdding(true);
  };

  const handleEditTarget = (target: Target) => {
    setEditingTarget({ ...target });
    setIsAdding(false);
  };

  const handleDeleteTarget = async (id: string) => {
    const newTargets = targets.filter((t) => t.id !== id);
    await handleSaveTargets(newTargets);
    setResults((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  };

  const handleSaveEdit = async () => {
    if (!editingTarget) return;
    if (!editingTarget.name || !editingTarget.host || !editingTarget.port) return;

    let newTargets: Target[];
    let shouldClearStats = false;

    if (isAdding) {
      newTargets = [...targets, editingTarget];
    } else {
      // Check if host or port changed
      const oldTarget = targets.find((t) => t.id === editingTarget.id);
      if (oldTarget && (oldTarget.host !== editingTarget.host || oldTarget.port !== editingTarget.port)) {
        shouldClearStats = true;
      }
      newTargets = targets.map((t) => (t.id === editingTarget.id ? editingTarget : t));
    }

    if (shouldClearStats) {
      setResults((prev) => {
        const next = new Map(prev);
        next.delete(editingTarget.id);
        return next;
      });
    }

    await handleSaveTargets(newTargets);
    setEditingTarget(null);
  };

  const handleRefresh = (id: string) => {
    setResults((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  };

  const handleRefreshAll = () => {
    setResults(new Map());
  };

  const handleMove = (index: number, direction: "up" | "down" | "top" | "bottom") => {
    let newIndex: number;
    if (direction === "up" && index > 0) {
      newIndex = index - 1;
    } else if (direction === "down" && index < targets.length - 1) {
      newIndex = index + 1;
    } else if (direction === "top" && index > 0) {
      newIndex = 0;
    } else if (direction === "bottom" && index < targets.length - 1) {
      newIndex = targets.length - 1;
    } else {
      return;
    }

    const movedId = targets[index].id;
    const newTargets = [...targets];
    const [removed] = newTargets.splice(index, 1);
    newTargets.splice(newIndex, 0, removed);
    setTargets(newTargets);
    setHighlightedId(movedId);
    // Save in background
    saveTargets(newTargets);
    invoke("set_targets", { targets: newTargets });
  };

  const handleCancelEdit = () => {
    setEditingTarget(null);
  };

  const handleImportFile = async () => {
    const path = await open({
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path || Array.isArray(path)) return;

    try {
      const txt = await readTextFile(path);
      const imported = parseTargetsJson(txt);
      if (imported && imported.length > 0) {
        await handleSaveTargets(imported);
        setResults(new Map());
      }
    } catch (e) {
      console.error("Failed to import:", e);
    }
  };

  const handleExportFile = () => {
    const json = JSON.stringify(targets, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "targets.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  // Compute stats for each target
  const stats: TargetStats[] = targets.map((target) => {
    const targetResults = results.get(target.id) || [];
    const okResults = targetResults.filter((r) => r.ok);
    const successRate = targetResults.length > 0 ? okResults.length / targetResults.length : null;
    const latencies = okResults.map((r) => r.latency_ms);
    const average = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;
    const p90 = quantile(latencies, 0.90);
    const lastResult = targetResults.length > 0 ? targetResults[targetResults.length - 1] : null;
    const health = computeHealth(successRate, average, p90);

    return { target, results: targetResults, successRate, average, p90, lastResult, health };
  });

  const fmtMs = (v: number | null) => (v === null ? "—" : `${Math.round(v)} ms`);
  const fmtPct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

  return (
    <div className={`app ${dragOver ? "drag-over" : ""}`}>
      <header>
        <h1>Network Tester</h1>
        <div className="actions">
          <button onClick={handleAddTarget}>Add Target</button>
          <button onClick={handleRefreshAll} disabled={targets.length === 0}>
            Refresh All
          </button>
          <button onClick={handleImportFile}>Import JSON</button>
          <button onClick={handleExportFile} disabled={targets.length === 0}>
            Export JSON
          </button>
        </div>
      </header>

      {dragOver && <div className="drop-overlay">Drop JSON file to import</div>}

      {editingTarget && (
        <div className="modal-overlay" onMouseDown={handleCancelEdit}>
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <h2>{isAdding ? "Add Target" : "Edit Target"}</h2>
            <div className="form-group">
              <label>Name</label>
              <input
                type="text"
                value={editingTarget.name}
                onChange={(e) => setEditingTarget({ ...editingTarget, name: e.target.value })}
                placeholder="e.g., Google DNS"
              />
            </div>
            <div className="form-group">
              <label>Host</label>
              <input
                type="text"
                value={editingTarget.host}
                onChange={(e) => setEditingTarget({ ...editingTarget, host: e.target.value })}
                placeholder="e.g., 8.8.8.8 or example.com"
              />
            </div>
            <div className="form-group">
              <label>Port</label>
              <input
                type="number"
                value={editingTarget.port}
                onChange={(e) =>
                  setEditingTarget({ ...editingTarget, port: parseInt(e.target.value) || 0 })
                }
                placeholder="e.g., 443"
              />
            </div>
            <div className="modal-actions">
              <button onClick={handleCancelEdit}>Cancel</button>
              <button className="primary" onClick={handleSaveEdit}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      <main>
        {targets.length === 0 ? (
          <div className="empty">
            <p>No targets configured.</p>
            <p>Click "Add Target" or drag a JSON file to get started.</p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th className="order-col">Order</th>
                <th>Name</th>
                <th>Host:Port</th>
                <th>Health</th>
                <th>Last</th>
                <th>Avg</th>
                <th>p90</th>
                <th>Success (5m)</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {stats.map(({ target, successRate, average, p90, lastResult, health }, index) => (
                <tr
                  key={target.id}
                  className={highlightedId === target.id ? "highlighted" : ""}
                >
                  <td className="order-cell">
                    <button
                      className="move-btn"
                      onClick={() => handleMove(index, "top")}
                      disabled={index === 0}
                      title="Move to top"
                    >
                      ⏶
                    </button>
                    <button
                      className="move-btn"
                      onClick={() => handleMove(index, "up")}
                      disabled={index === 0}
                      title="Move up"
                    >
                      ▲
                    </button>
                    <button
                      className="move-btn"
                      onClick={() => handleMove(index, "down")}
                      disabled={index === stats.length - 1}
                      title="Move down"
                    >
                      ▼
                    </button>
                    <button
                      className="move-btn"
                      onClick={() => handleMove(index, "bottom")}
                      disabled={index === stats.length - 1}
                      title="Move to bottom"
                    >
                      ⏷
                    </button>
                  </td>
                  <td>{target.name}</td>
                  <td className="mono">
                    {target.host}:{target.port}
                  </td>
                  <td>
                    <span className={`pill ${health}`}>
                      {health.toUpperCase()}
                    </span>
                  </td>
                  <td>
                    {lastResult
                      ? lastResult.ok
                        ? fmtMs(lastResult.latency_ms)
                        : `FAIL`
                      : "—"}
                  </td>
                  <td>{fmtMs(average)}</td>
                  <td>{fmtMs(p90)}</td>
                  <td>{fmtPct(successRate)}</td>
                  <td className="actions-cell">
                    <button className="small" onClick={() => handleRefresh(target.id)}>
                      Refresh
                    </button>
                    <button className="small" onClick={() => handleEditTarget(target)}>
                      Edit
                    </button>
                    <button className="small danger" onClick={() => handleDeleteTarget(target.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>

      <footer>
        <div className="footer-left">
          <span>Probing every 5s • Window: 5min</span>
          <span className="storage-info">
            {storageMode === "portable"
              ? "Storage: Portable (targets.json next to exe)"
              : "Storage: AppData (place targets.json next to exe for portable mode)"}
          </span>
        </div>
        <button className="info-btn" onClick={() => setShowInfo(!showInfo)}>
          {showInfo ? "Hide Info" : "Info"}
        </button>
      </footer>

      {showInfo && (
        <div className="info-panel">
          <h3>How It Works</h3>
          <ul>
            <li><strong>Probing:</strong> TCP connect test every 5 seconds per target</li>
            <li><strong>Stats:</strong> Calculated over a 5-minute rolling window</li>
            <li><strong>Health:</strong> Based on success rate, average latency, and p90 latency</li>
          </ul>

          <h3>Health Categories</h3>
          <ul>
            <li><strong>OPTIMAL:</strong> ≥99.5% success, avg ≤15ms, p90 ≤30ms</li>
            <li><strong>GREAT:</strong> ≥99% success, avg ≤30ms, p90 ≤80ms</li>
            <li><strong>GOOD:</strong> ≥98% success, avg ≤80ms, p90 ≤200ms</li>
            <li><strong>WARN:</strong> ≥95% success</li>
            <li><strong>BAD:</strong> ≥70% success</li>
            <li><strong>DOWN:</strong> &lt;70% success</li>
          </ul>

          <h3>Storage ({storageMode === "portable" ? "Portable Mode" : "AppData Mode"})</h3>
          <p className="storage-path">{storagePath}</p>
          <ul>
            <li><strong>Portable:</strong> Place <code>targets.json</code> next to the exe to use portable mode</li>
            <li><strong>AppData:</strong> Default mode - saves to system AppData folder</li>
            <li><strong>Auto-save:</strong> Changes saved immediately on add/edit/delete</li>
          </ul>

          <h3>Actions</h3>
          <ul>
            <li><strong>Refresh:</strong> Clear stats for a target (useful when server recovers)</li>
            <li><strong>Import:</strong> Drag .json file onto window or click Import JSON</li>
            <li><strong>Export:</strong> Download current targets as JSON file</li>
          </ul>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        style={{ display: "none" }}
      />
    </div>
  );
}
