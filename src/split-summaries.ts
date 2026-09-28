// /split_summaries is an unofficial payload. Project only a bounded set of
// running metrics; never pass unknown keys (which can contain GPS) to MCP.
const numeric = new Set([
  "distance", "duration", "elapsedDuration", "movingDuration", "averageSpeed", "maxSpeed",
  "averageHR", "maxHR", "averageRunCadence", "maxRunCadence", "elevationGain", "elevationLoss",
  "averagePower", "maxPower", "calories", "lapCount", "splitCount", "totalDistance",
]);
const labels = new Set(["splitType", "intensityType"]);
const groups = new Set(["splitSummaries", "splitSummaryDTOs", "splits"]);

export function safeSplitSummaries(payload: unknown): unknown {
  const project = (value: unknown, depth: number): unknown => {
    if (depth > 3) return null;
    if (Array.isArray(value)) return value.slice(0, 100).map((entry) => project(entry, depth + 1));
    if (!value || typeof value !== "object") return null;
    return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
      if (numeric.has(key) && typeof entry === "number" && Number.isFinite(entry)) return [[key, entry]];
      if (labels.has(key) && typeof entry === "string" && /^[a-z0-9_-]{1,40}$/i.test(entry)) return [[key, entry]];
      if (groups.has(key) && Array.isArray(entry)) return [[key, project(entry, depth + 1)]];
      return [];
    }));
  };
  return project(payload, 0);
}
