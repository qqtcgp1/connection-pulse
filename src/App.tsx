import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type { Target, ProbeResult, TargetStats } from "./types";
import { loadTargets, saveTargets, parseTargetsJson, getStorageInfo, StorageMode } from "./storage";
import { platform } from "@tauri-apps/plugin-os";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

const WINDOW_MS = 5 * 60 * 1000; // 5 minute rolling window

const EXAMPLE_TARGETS: Omit<Target, "id">[] = [
  { name: "Cloudflare", host: "1.1.1.1", port: 443, probe_type: "tcp" },
  { name: "Netflix", host: "netflix.com", port: 443, probe_type: "tcp" },
  { name: "Google DNS", host: "8.8.8.8", port: 53, probe_type: "tcp" },
  { name: "YouTube", host: "youtube.com", port: 443, probe_type: "tcp" },
  { name: "Cloudflare Ping", host: "1.1.1.1", port: 0, probe_type: "ping" },
  { name: "Google Ping", host: "google.com", port: 0, probe_type: "ping" },
  { name: "Microsoft Ping", host: "outlook.office365.com", port: 0, probe_type: "ping" },
  { name: "Amazon", host: "amazon.com", port: 443, probe_type: "tcp" },
];

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

const fmtMs = (v: number | null) => (v === null ? "—" : `${Math.round(v)} ms`);
const fmtPct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

// Sortable row component
interface SortableRowProps {
  stat: TargetStats;
  onRefresh: (id: string) => void;
  onEdit: (target: Target) => void;
  onDelete: (id: string) => void;
}

function SortableRow({ stat, onRefresh, onEdit, onDelete }: SortableRowProps) {
  const { target, successRate, average, p90, lastResult, health } = stat;

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: target.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  // Apply drag listeners only to handle (both mobile and desktop)
  const rowProps = {};
  const handleProps = { ...attributes, ...listeners };

  return (
    <tr ref={setNodeRef} style={style} className={isDragging ? "dragging" : ""} {...rowProps}>
      <td className="drag-handle" {...handleProps} title="Drag to reorder">☰</td>
      <td data-label="Name">{target.name}</td>
      <td className="mono" data-label={target.probe_type === "ping" ? "Host" : "Host:Port"}>
        {target.probe_type === "ping" ? `ping ${target.host}` : `${target.host}:${target.port}`}
      </td>
      <td data-label="Health">
        <span className={`pill ${health}`}>
          {health.toUpperCase()}
        </span>
      </td>
      <td data-label="Last">
        {lastResult
          ? lastResult.ok
            ? fmtMs(lastResult.latency_ms)
            : `FAIL`
          : "—"}
      </td>
      <td data-label="Avg">{fmtMs(average)}</td>
      <td data-label="p90">{fmtMs(p90)}</td>
      <td data-label="Success">{fmtPct(successRate)}</td>
      <td className="actions-cell">
        <button className="small" onClick={() => onRefresh(target.id)} title="Refresh">
          <span className="btn-icon">↻</span>
          <span className="btn-text">Refresh</span>
        </button>
        <button className="small" onClick={() => onEdit(target)} title="Edit">
          <span className="btn-icon">✎</span>
          <span className="btn-text">Edit</span>
        </button>
        <button className="small danger" onClick={() => onDelete(target.id)} title="Delete">
          <span className="btn-icon">✕</span>
          <span className="btn-text">Delete</span>
        </button>
      </td>
    </tr>
  );
}

export default function App() {
  const [targets, setTargets] = useState<Target[]>([]);
  const [results, setResults] = useState<Map<string, ProbeResult[]>>(new Map());
  const [editingTarget, setEditingTarget] = useState<Target | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [storageMode, setStorageMode] = useState<StorageMode>("appdata");
  const [storagePath, setStoragePath] = useState<string>("");
  const [isMobile, setIsMobile] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [showSplash, setShowSplash] = useState(true); // Mobile splash screen
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // dnd-kit sensors - pointer for mouse, touch for mobile
  const pointerSensor = useSensor(PointerSensor, {
    activationConstraint: {
      distance: 8, // 8px movement before drag starts
    },
  });
  const touchSensor = useSensor(TouchSensor, {
    activationConstraint: {
      delay: 500,
      tolerance: 10,
    },
  });
  // Use only TouchSensor on mobile, only PointerSensor on desktop
  const mobileSensors = useSensors(touchSensor);
  const desktopSensors = useSensors(pointerSensor);

  // Load targets and storage info on mount
  useEffect(() => {
    (async () => {
      const os = await platform();
      setIsMobile(os === "android" || os === "ios");
      const info = await getStorageInfo();
      setStorageMode(info.mode);
      setStoragePath(info.path);
      const loaded = await loadTargets();
      setTargets(loaded);
      await invoke("set_targets", { targets: loaded });
      // If no targets, dismiss splash immediately (no probes will fire)
      if (loaded.length === 0) {
        setShowSplash(false);
      }
    })();
  }, []);

  // Splash screen timeout (max 2.5 seconds)
  useEffect(() => {
    const timeout = setTimeout(() => {
      setShowSplash(false);
    }, 2500);
    return () => clearTimeout(timeout);
  }, []);

  // Mobile: refresh stats when app resumes from background
  // (Android/iOS restrict network in background, causing stale "DOWN" states)
  useEffect(() => {
    if (!isMobile) return;

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        // App came to foreground - clear old stats so fresh probes show accurate state
        setResults(new Map());
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isMobile]);

  // Listen for probe updates
  useEffect(() => {
    const unlisten = listen<ProbeResult>("probe:update", (event) => {
      const result = event.payload;
      // Hide splash screen on first probe result (mobile only)
      setShowSplash(false);
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

  // HTML5 file drop handlers (desktop only - separate from row reordering)
  const handleFileDragOver = (e: React.DragEvent) => {
    if (isMobile) return;
    e.preventDefault();
    // Only show overlay for external file drops
    if (e.dataTransfer.types.includes("Files")) {
      setDragOver(true);
    }
  };

  const handleFileDragLeave = (e: React.DragEvent) => {
    if (isMobile) return;
    e.preventDefault();
    if (e.currentTarget === e.target) {
      setDragOver(false);
    }
  };

  const handleFileDrop = async (e: React.DragEvent) => {
    if (isMobile) return;
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
    setEditingTarget({ id: generateId(), name: "", host: "", port: 443, probe_type: "tcp" });
    setIsAdding(true);
  };

  const handleLoadExamples = async () => {
    const exampleTargets = EXAMPLE_TARGETS.map((t) => ({ ...t, id: generateId() }));
    await handleSaveTargets(exampleTargets);
  };

  const handleEditTarget = (target: Target) => {
    setEditingTarget({ ...target });
    setIsAdding(false);
  };

  const handleDeleteTarget = (id: string) => {
    const target = targets.find((t) => t.id === id);
    const name = target?.name || "this target";
    setDeleteConfirm({ id, name });
  };

  const confirmDelete = async () => {
    if (!deleteConfirm) return;
    const newTargets = targets.filter((t) => t.id !== deleteConfirm.id);
    await handleSaveTargets(newTargets);
    setResults((prev) => {
      const next = new Map(prev);
      next.delete(deleteConfirm.id);
      return next;
    });
    setDeleteConfirm(null);
  };

  const handleSaveEdit = async () => {
    if (!editingTarget) return;
    if (!editingTarget.name || !editingTarget.host) return;
    if (editingTarget.probe_type === "tcp" && !editingTarget.port) return;

    // Ensure ping targets have port 0
    const targetToSave = editingTarget.probe_type === "ping"
      ? { ...editingTarget, port: 0 }
      : editingTarget;

    let newTargets: Target[];
    let shouldClearStats = false;

    if (isAdding) {
      newTargets = [...targets, targetToSave];
    } else {
      // Check if host, port, or probe_type changed
      const oldTarget = targets.find((t) => t.id === targetToSave.id);
      if (oldTarget && (oldTarget.host !== targetToSave.host || oldTarget.port !== targetToSave.port || oldTarget.probe_type !== targetToSave.probe_type)) {
        shouldClearStats = true;
      }
      newTargets = targets.map((t) => (t.id === targetToSave.id ? targetToSave : t));
    }

    if (shouldClearStats) {
      setResults((prev) => {
        const next = new Map(prev);
        next.delete(targetToSave.id);
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

  // dnd-kit drag end handler
  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = targets.findIndex((t) => t.id === active.id);
      const newIndex = targets.findIndex((t) => t.id === over.id);

      const newTargets = arrayMove(targets, oldIndex, newIndex);
      await handleSaveTargets(newTargets);
    }
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

  return (
    <div
      className={`app ${dragOver ? "drag-over" : ""}`}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
    >
      {/* Mobile splash screen */}
      {isMobile && showSplash && (
        <div className="splash-screen">
          <div className="splash-icon">
            <div className="splash-icon-pulse"></div>
            <div className="splash-icon-dot"></div>
          </div>
          <div className="splash-title">ConnectionPulse</div>
          <div className="splash-loader"></div>
          <div className="splash-status">Initializing probes...</div>
        </div>
      )}

      <header>
        <h1>Connection Pulse</h1>
        <div className="actions">
          {targets.length === 0 && (
            <button className="examples-btn" onClick={handleLoadExamples} title="Load Examples">
              Load Examples
            </button>
          )}
          <button onClick={handleAddTarget} title="Add Target">+</button>
          <button onClick={handleRefreshAll} disabled={targets.length === 0} title="Refresh All">↻</button>
          <button className="desktop-only" onClick={handleImportFile} title="Import JSON">↓</button>
          <button className="desktop-only" onClick={handleExportFile} disabled={targets.length === 0} title="Export JSON">↑</button>
        </div>
      </header>

      {dragOver && <div className="drop-overlay">Drop JSON file to import</div>}

      {editingTarget && (
        <div className="modal-overlay" onMouseDown={handleCancelEdit}>
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <h2>{isAdding ? "Add Target" : "Edit Target"}</h2>
            <div className="form-group">
              <label>Type</label>
              <div className="type-selector">
                <button
                  className={`type-btn ${editingTarget.probe_type === "tcp" ? "active" : ""}`}
                  onClick={() => setEditingTarget({ ...editingTarget, probe_type: "tcp", port: editingTarget.probe_type === "ping" ? 443 : editingTarget.port })}
                  type="button"
                >
                  TCP
                </button>
                <button
                  className={`type-btn ${editingTarget.probe_type === "ping" ? "active" : ""}`}
                  onClick={() => setEditingTarget({ ...editingTarget, probe_type: "ping", port: 0 })}
                  type="button"
                >
                  Ping
                </button>
              </div>
            </div>
            <div className="form-group">
              <label>Name</label>
              <input
                type="text"
                inputMode="text"
                autoComplete="off"
                value={editingTarget.name}
                onChange={(e) => setEditingTarget({ ...editingTarget, name: e.target.value })}
                placeholder="e.g., Google DNS"
              />
            </div>
            <div className="form-group">
              <label>Host</label>
              <input
                type="text"
                inputMode="url"
                autoComplete="off"
                value={editingTarget.host}
                onChange={(e) => setEditingTarget({ ...editingTarget, host: e.target.value })}
                placeholder={editingTarget.probe_type === "ping" ? "e.g., 8.8.8.8 or example.com" : "e.g., 8.8.8.8 or example.com"}
              />
            </div>
            {editingTarget.probe_type === "tcp" && (
              <div className="form-group">
                <label>Port</label>
                <input
                  type="number"
                  inputMode="numeric"
                  autoComplete="off"
                  value={editingTarget.port}
                  onChange={(e) =>
                    setEditingTarget({ ...editingTarget, port: parseInt(e.target.value) || 0 })
                  }
                  placeholder="e.g., 443"
                />
              </div>
            )}
            <div className="modal-actions">
              <button onClick={handleCancelEdit}>Cancel</button>
              <button className="primary" onClick={handleSaveEdit}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirm && (
        <div className="modal-overlay" onMouseDown={() => setDeleteConfirm(null)}>
          <div className="modal confirm-modal" onMouseDown={(e) => e.stopPropagation()}>
            <h2>Confirm Delete</h2>
            <p>Delete "{deleteConfirm.name}"?</p>
            <div className="modal-actions">
              <button onClick={() => setDeleteConfirm(null)}>Cancel</button>
              <button className="danger" onClick={confirmDelete}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      <main>
        {targets.length === 0 ? (
          <div className="empty">
            <p>No targets configured.</p>
            <p>Click + to add a target, or try some examples:</p>
            <button className="load-examples-btn" onClick={handleLoadExamples}>
              Load Examples
            </button>
          </div>
        ) : (
          <DndContext
            sensors={isMobile ? mobileSensors : desktopSensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={targets.map((t) => t.id)}
              strategy={verticalListSortingStrategy}
            >
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
                <tbody>
                  {stats.map((stat) => (
                    <SortableRow
                      key={stat.target.id}
                      stat={stat}
                      onRefresh={handleRefresh}
                      onEdit={handleEditTarget}
                      onDelete={handleDeleteTarget}
                    />
                  ))}
                </tbody>
              </table>
            </SortableContext>
          </DndContext>
        )}
      </main>

      <footer>
        <div className="footer-left">
          <span>Probing every 5s • Window: 5min</span>
          {!isMobile && (
            <span className="storage-info">
              {storageMode === "portable"
                ? "Storage: Portable (targets.json next to exe)"
                : "Storage: AppData (place targets.json next to exe for portable mode)"}
            </span>
          )}
        </div>
        <button className="info-btn" onClick={() => setShowInfo(!showInfo)}>
          {showInfo ? "Hide Info" : "Info"}
        </button>
      </footer>

      {showInfo && (
        <div className="info-panel">
          <h3>How It Works</h3>
          <ul>
            <li><strong>Probing:</strong> TCP connect or ICMP ping test every 5 seconds per target</li>
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

          <h3>Storage {isMobile ? "" : `(${storageMode === "portable" ? "Portable Mode" : "System Mode"})`}</h3>
          {!isMobile && <p className="storage-path">{storagePath}</p>}
          <ul>
            {isMobile ? (
              <>
                <li><strong>Location:</strong> App internal storage (managed by the system)</li>
                <li><strong>Auto-save:</strong> Changes saved immediately on add/edit/delete</li>
              </>
            ) : (
              <>
                <li><strong>Portable:</strong> Place <code>targets.json</code> next to the exe to use portable mode</li>
                <li><strong>System (default):</strong></li>
                <ul>
                  <li>Windows: <code>%APPDATA%/com.connection-pulse.app/</code></li>
                  <li>macOS: <code>~/Library/Application Support/com.connection-pulse.app/</code></li>
                  <li>Linux: <code>~/.config/com.connection-pulse.app/</code></li>
                </ul>
                <li><strong>Auto-save:</strong> Changes saved immediately on add/edit/delete</li>
              </>
            )}
          </ul>

          <h3>Actions</h3>
          <ul>
            <li><strong>Refresh:</strong> Clear stats for a target (useful when server recovers)</li>
            <li><strong>Reorder:</strong> Drag rows using the ☰ handle</li>
            {!isMobile && (
              <>
                <li><strong>Import:</strong> Drag .json file onto window or click Import JSON</li>
                <li><strong>Export:</strong> Download current targets as JSON file</li>
              </>
            )}
          </ul>

          <h3>About</h3>
          <p style={{ color: "#888", fontSize: "12px", lineHeight: "1.5" }}>
            Personal, experimental project. Shared as-is, without guarantees.
            Not intended for production use or supported deployment.
            <br /><br />
            Licensed under the MIT License.
            <br />
            <a href="https://github.com/qqtcgp1/connection-pulse" target="_blank" rel="noopener noreferrer" style={{ color: "#60a5fa" }}>
              https://github.com/qqtcgp1/connection-pulse
            </a>
          </p>
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
