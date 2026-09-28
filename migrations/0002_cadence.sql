-- Garmin currently names this field StepsPerMinute, not StepsPerMin.
-- Repair runs already cached before the adapter field name was corrected.
UPDATE runs
SET avg_cadence_spm = json_extract(raw_summary, '$.averageRunningCadenceInStepsPerMinute')
WHERE avg_cadence_spm IS NULL
  AND json_type(raw_summary, '$.averageRunningCadenceInStepsPerMinute') IN ('integer', 'real')
  AND json_extract(raw_summary, '$.averageRunningCadenceInStepsPerMinute') > 0;
