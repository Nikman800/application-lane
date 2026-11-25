// Where an application stands, in the words the command line's tabs
// (npm run lane -- ui) and the browser's tab groups both use, so the two
// always sort an application the same way.

export const laneGroups = ["needs you", "needs fixing", "being fixed", "in progress", "failed", "ready to review", "submitted", "closed"] as const;
export type LaneGroup = (typeof laneGroups)[number];

export type LaneGroupInput = {
  status: string;
  stage: string;
  lastFill?: { status: string };
  // AI is still filling what the profile left: not yet the applicant's.
  assisting?: boolean;
};

// `repair` is what the fixer's record says (section() in repairs.ts): an
// application it has a repair open on is left alone until that is done.
export function laneGroup(app: LaneGroupInput, repair?: "needs fixing" | "being fixed"): LaneGroup {
  if (app.stage === "submitted") return "submitted";
  if (app.status === "cancelled" || app.stage === "abandoned") return "closed";
  if (repair) return repair;
  if (app.status === "failed" || app.lastFill?.status === "error") return "failed";
  if (["queued", "inspecting", "preparing", "filling"].includes(app.status) || app.assisting) return "in progress";
  if (app.status === "ready") return "ready to review";
  return "needs you";
}
