export interface Target {
  id: string;
  name: string;
  host: string;
  port: number;
  probe_type: "tcp" | "ping";
}

export interface ProbeResult {
  id: string;
  ok: boolean;
  latency_ms: number;
  error: string | null;
  timestamp: number;
}

export interface TargetStats {
  target: Target;
  results: ProbeResult[];
  successRate: number | null;
  average: number | null;
  p90: number | null;
  lastResult: ProbeResult | null;
  health: "optimal" | "great" | "good" | "warn" | "bad" | "down" | "unknown";
}
