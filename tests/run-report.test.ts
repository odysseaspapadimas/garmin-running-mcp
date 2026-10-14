import { expect, it } from "vitest";
import { hrZones, runReport } from "../src/run-report.js";
import type { Run } from "../src/storage.js";

it("distinguishes unfetched, empty and malformed HR-zone responses", () => {
  expect(hrZones(null).status).toBe("not_fetched");
  expect(hrZones("null").status).toBe("unavailable");
  expect(hrZones("[]").status).toBe("unavailable");
  expect(hrZones('{"unexpected":true}').status).toBe("unrecognized_response");
  expect(hrZones('[{"zoneNumber":4,"secsInZone":-1}]').status).toBe("unrecognized_response");
  expect(hrZones('[{"zoneNumber":4,"secsInZone":100},{"zoneNumber":5}]').zones).toBeNull();
});

it("retains real zone seconds including zero, without inferring missing boundaries", () => {
  expect(hrZones('[{"zoneNumber":1,"secsInZone":0,"privateData":"hidden"}]')).toEqual({
    status: "available", zones: [{ zoneNumber: 1, secsInZone: 0, zoneLowBoundary: null }],
  });
});

it("reports incomplete charts and zones even if laps are complete", () => {
  const run = { raw_summary: "{}", raw_laps: '{"lapDTOs":[{"distance":1000,"movingDuration":360}]}',
    raw_detail: "null", raw_hr_zones: "null" } as Run;
  const report = runReport(run);
  expect(report.details_pending).toBe(false);
  expect(report.full_details_pending).toBe(true);
  expect(report.data_status).toEqual({ laps: "available", hr_zones: "unavailable", chart: "unavailable" });
  expect(report.hr_time_in_zones).toBeNull();
});
