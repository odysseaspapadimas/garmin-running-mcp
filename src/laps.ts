// Garmin's /splits payload is unofficial and can include precise location.
// Return only an allowlist of per-lap running metrics to the model.
export function averageLapCadence(payload: unknown): number | null {
  if (!payload || typeof payload !== "object" || !("lapDTOs" in payload) || !Array.isArray(payload.lapDTOs)) return null;
  let weightedCadence = 0;
  let movingSeconds = 0;
  for (const lap of payload.lapDTOs) {
    const cadence = lap?.averageRunCadence;
    const duration = lap?.movingDuration ?? lap?.duration;
    if (typeof cadence === "number" && Number.isFinite(cadence) && cadence > 0 &&
        typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
      weightedCadence += cadence * duration;
      movingSeconds += duration;
    }
  }
  return movingSeconds ? weightedCadence / movingSeconds : null;
}

export function safeLaps(payload: unknown) {
  if (!payload || typeof payload !== "object" || !("lapDTOs" in payload) || !Array.isArray(payload.lapDTOs)) return [];
  return payload.lapDTOs.slice(0, 150).map((lap: Record<string, unknown>, index: number) => {
    const num = (key: string) => typeof lap[key] === "number" && Number.isFinite(lap[key]) ? lap[key] as number : null;
    const distance = num("distance");
    const duration = num("movingDuration") ?? num("duration");
    return {
      lap: num("lapIndex") ?? index + 1,
      distance_m: distance, duration_s: num("duration"), moving_s: num("movingDuration"),
      pace_sec_per_km: distance && duration ? duration * 1000 / distance : null,
      avg_hr_bpm: num("averageHR"), max_hr_bpm: num("maxHR"),
      avg_cadence_spm: num("averageRunCadence"),
      ascent_m: num("elevationGain"), descent_m: num("elevationLoss"),
      intensity: typeof lap.intensityType === "string" ? lap.intensityType : null,
    };
  });
}
