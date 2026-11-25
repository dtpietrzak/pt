// Fallback only: the real defaults come from data/profile.json (PT Bot's seed/profile.json).
export const DEFAULT_PROFILE = {
  name: "David Pietrzak",
  sports: ["soccer", "football"],
  timezone: "America/Chicago",
  body_weight_lb: 180,
  equipment: {
    bands: true, dumbbells_lb: [], kettlebells_lb: [], barbell: true, plates_lb: [], rack_with_safeties: true,
    bench: true, pull_up_bar: true, step_box_in: [6, 8, 12, 18], blocks: true, cones: true, track_or_field: true,
  },
  baselines: { pain_rest: 1, stiffness_min: 30, standing_h: 5, sitting_min: 20 },
  notify: { morning: "08:00", evening: "15:30", night: "21:00", post_workout: "on_session_complete" },
  settings: { max_item_changes_per_finalized_session: 3, layoff_rule_enabled: true, clean_exposures_required: 2,
    posture_cycle: { enabled: true, work_start: "08:00", work_end: "17:00", quiet_outside_work_hours: true, snooze_min: 5, max_snoozes_per_phase: 2 } },
};
// App-only settings that the profile schema has no field for.
export const DEFAULT_APP = {
  start_level: "L2",
  reminders_enabled: false,
  // Work timer: alarms ring only on the device that started work mode, unless this is on.
  timer_alarm_all_devices: false,
  timer_sound: true,
};
export const DISCLAIMER = "This app supports self-management of a recovering lumbar disc. It is not medical advice, does not diagnose, and does not replace a clinician.";
