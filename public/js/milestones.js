// Rehabilitation milestones: provisional target dates for each level, shown on the Plan page.
// Targets only. Check-ins and gate tests still decide when a level actually changes.
// `end` is the last day of the level; L8 is open-ended (milestone-based).
export const MILESTONES = [
  { id: "L1", start: "2026-11-25", end: "2026-12-08", length: "2 weeks", focus: "Finish establishing reliable neutral-spine control and repeatable exercise tolerance." },
  { id: "L2", start: "2026-12-09", end: "2027-01-05", length: "4 weeks", focus: "Build trunk endurance, hip strength, walking capacity, and bodyweight movement tolerance." },
  { id: "L3", start: "2027-01-06", end: "2027-02-02", length: "4 weeks", focus: "Introduce light external resistance, unilateral exercises, and controlled single-leg loading." },
  { id: "L4", start: "2027-02-03", end: "2027-03-02", length: "4 weeks", focus: "Build progressive resistance in squats, hinges, rows, and other controlled strength movements." },
  { id: "L5", start: "2027-03-03", end: "2027-04-13", length: "6 weeks", focus: "Develop lifting from lower positions, pressing, pulling, and introductory impact preparation." },
  { id: "L6", start: "2027-04-14", end: "2027-05-25", length: "6 weeks", focus: "Introduce carefully dosed barbell movements and a gradual walk-jog progression." },
  { id: "L7", start: "2027-05-26", end: "2027-07-06", length: "6 weeks", focus: "Build strength and introduce progressive acceleration, running mechanics, and controlled power." },
  { id: "L8", start: "2027-07-07", end: null, length: "Milestone-based", focus: "Progress through sport-specific drills, cutting, acceleration, deceleration, and eventually contact." },
];

/** The milestone whose target window contains `ymd` (L8 covers everything after its start). */
export const milestoneOn = (ymd) => MILESTONES.find((m) => ymd >= m.start && (!m.end || ymd <= m.end)) || null;
