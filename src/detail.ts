// Whitelist optional Garmin summary/chart metrics. Never return polylines,
// coordinates, exact location names, or a raw JSON blob to an LLM.
const summaryKeys = ["calories", "lapCount", "vO2MaxValue", "trainingEffect", "anaerobicTrainingEffect", "averagePower", "minTemperature", "maxTemperature"];
const allowedChart = /heart.?rate|cadence|distance|speed|pace|elevation|altitude|power|timer.?time|timestamp/i;

export function safeDetail(summaryJson: string) {
  const summary = JSON.parse(summaryJson) as Record<string, unknown>;
  return { extra_summary: Object.fromEntries(summaryKeys.filter((key) => typeof summary[key] === "number").map((key) => [key, summary[key]])) };
}

export function safeChart(detailJson: string | null | undefined, offset: number, limit: number) {
  if (!detailJson) return { samples: [], chart_units: {}, offset, next_offset: null };
  const detail = JSON.parse(detailJson) as {
    metricDescriptors?: { metricsIndex: number; key: string; unit?: { key?: string } }[];
    activityDetailMetrics?: { metrics: (number | null)[] }[];
  };
  const descriptors = (detail.metricDescriptors ?? [])
    .filter((d) => Number.isInteger(d.metricsIndex) && d.metricsIndex >= 0 && typeof d.key === "string" && allowedChart.test(d.key) && !/lat|lon|geo|coordinate/i.test(d.key))
    .slice(0, 12);
  const rows = detail.activityDetailMetrics ?? [];
  const samples = rows.slice(offset, offset + limit).map((row) =>
    Object.fromEntries(descriptors.map((d) => [d.key, typeof row.metrics?.[d.metricsIndex] === "number" ? row.metrics[d.metricsIndex] : null])),
  );
  return { samples, chart_units: Object.fromEntries(descriptors.map((d) => [d.key, d.unit?.key ?? null])),
    offset, next_offset: offset + limit < rows.length ? offset + limit : null };
}
