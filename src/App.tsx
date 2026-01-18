import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
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
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
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

  // HTML5 file drop handlers
  const handleFileDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    // Only show overlay for external file drops, not internal row drags
    if (e.dataTransfer.types.includes("Files")) {
      setDragOver(true);
    }
  };

  const handleFileDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    // Only hide if leaving the app container
    if (e.currentTarget === e.target) {
      setDragOver(false);
    }
  };

  const handleFileDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);

    const files = Array.from(e.dataTransfer.files);
    const jsonFile = files.find((f) => f.name.toLowerCase().endsWith(".json"));
    if (!jsonFile) return;

    try {
      const txt = await jsonFile.text();
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
  };

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

  const handleRowDragStart = (e: React.DragEvent<HTMLTableRowElement>, index: number) => {
    setDraggedIndex(index);
    setHighlightedId(targets[index].id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(index));
    // Make the drag image semi-transparent
    if (e.currentTarget) {
      e.currentTarget.style.opacity = "0.5";
    }
  };

  const handleRowDragEnd = (e: React.DragEvent<HTMLTableRowElement>) => {
    setDraggedIndex(null);
    if (e.currentTarget) {
      e.currentTarget.style.opacity = "1";
    }
  };

  const handleRowDrop = (e: React.DragEvent<HTMLTableRowElement>, dropIndex: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === dropIndex) return;

    const newTargets = [...targets];
    const [removed] = newTargets.splice(draggedIndex, 1);
    // When dragging down, adjust for the shifted indices
    const insertIndex = draggedIndex < dropIndex ? dropIndex - 1 : dropIndex;
    newTargets.splice(insertIndex, 0, removed);
    setTargets(newTargets);
    setDraggedIndex(null);
    // Save in background
    saveTargets(newTargets);
    invoke("set_targets", { targets: newTargets });
  };

  const handleDropToEnd = (e: React.DragEvent) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === targets.length - 1) return;

    const newTargets = [...targets];
    const [removed] = newTargets.splice(draggedIndex, 1);
    newTargets.push(removed);
    setTargets(newTargets);
    setDraggedIndex(null);
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

  const handleExportFile = async () => {
    const path = await save({
      defaultPath: "targets.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return;

    try {
      const json = JSON.stringify(targets, null, 2);
      await writeTextFile(path, json);
    } catch (e) {
      console.error("Failed to export:", e);
    }
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
    <div
      className={`app ${dragOver ? "drag-over" : ""}`}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
    >
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
                <th className="drag-col"></th>
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
            <tbody
              onDragOver={(e) => e.preventDefault()}
              onDragEnter={(e) => e.preventDefault()}
            >
              {stats.map(({ target, successRate, average, p90, lastResult, health }, index) => (
                <tr
                  key={target.id}
                  className={`${draggedIndex === index ? "dragging" : ""} ${highlightedId === target.id ? "highlighted" : ""}`}
                  draggable
                  onDragStart={(e) => handleRowDragStart(e, index)}
                  onDragEnd={handleRowDragEnd}
                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                  onDrop={(e) => handleRowDrop(e, index)}
                >
                  <td className="drag-handle" title="Drag to reorder">☰</td>
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
              {draggedIndex !== null && (
                <tr
                  className="drop-end-zone"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={handleDropToEnd}
                >
                  <td colSpan={9}>Drop here to move to end</td>
                </tr>
              )}
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
