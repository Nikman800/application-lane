import { createHash } from "node:crypto";
import { answerChoices, canonicalAnswer, type ChoiceField } from "../shared/answers";
import type { Profile } from "../shared/model";
import { authorizationAnswer } from "../shared/authorization";
import { latestRow } from "../shared/education";
import type { SkillContext } from "./answers";
import { MONTH_NAMES_LOWER } from "../shared/dates";

// Answers kept both in the extension profile and in the job-applier
// markdown. Direct fills (yes/no, demographics, history rows) come from the
// extension profile and written answers from the markdown, so when the two
// disagree one application can contradict itself. This names each
// disagreement; it never picks a side.
export type ProfileConflict = {
  field: string;
  extension: string;
  markdown: string;
  file: "preferences.md" | "profile.md";
};

// "- **Label:** value" and "- **Label?** value" lines, with continuation
// lines folded in.
export function markdownEntries(markdown: string): Map<string, string> {
  const entries = new Map<string, string>();
  let last: string | undefined;
  for (const line of markdown.split("\n")) {
    const entry = line.match(/^\s*-\s+\*\*(.+?)[:?]?\*\*[:?]?\s*(.*)$/u);
    if (entry) {
      last = entry[1].trim().toLowerCase();
      entries.set(last, entry[2].trim());
    } else if (last && /^\s{2,}\S/u.test(line))
      entries.set(last, `${entries.get(last)} ${line.trim()}`);
    else last = undefined;
  }
  return entries;
}

const choiceFields: { label: RegExp; field: ChoiceField; name: string }[] = [
  { label: /^work authori[sz]ation/, field: "workAuthorization", name: "Work authorization" },
  { label: /sponsorship/, field: "sponsorship", name: "Visa sponsorship" },
  { label: /^relocation/, field: "willingToRelocate", name: "Relocation" },
  { label: /^veteran/, field: "veteranStatus", name: "Veteran status" },
];

const months = MONTH_NAMES_LOWER;
// "December 13, 2027" as 2027-12.
const monthYear = (text: string) => {
  const match = text.toLowerCase().match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(?:(\d{1,2}),?\s+)?(\d{4})\b/u);
  if (!match) return "";
  const month = months.findIndex((name) => name.startsWith(match[1])) + 1;
  return `${match[3]}-${String(month).padStart(2, "0")}`;
};

// "Graduation by role" in preferences.md: the date an internship or co-op
// application states, and the date a full-time or new-grad one states.
// Some applicants graduate later on purpose so they are still enrolled after
// a summer internship.
export type GraduationRule = { internship?: string; fullTime?: string };
export function graduationRule(preferences: string): GraduationRule {
  const entry = [...markdownEntries(preferences)].find(([key]) => /^graduation by role/.test(key))?.[1];
  if (!entry) return {};
  const after = (pattern: RegExp) => {
    const at = entry.search(pattern);
    return at < 0 ? "" : monthYear(entry.slice(at));
  };
  return {
    internship: after(/intern|co-?op/i) || undefined,
    fullTime: after(/full.?time|new.?grad/i) || undefined,
  };
}

// Banks call their internships summer analyst and summer associate programs
// ("Global Technology Summer Analyst 2027").
export const internshipRole = (title: string) =>
  /\b(intern|interns|internship|co-?op|summer (analyst|associate|program|scholar))\b/i.test(title);

export function graduationFor(rule: GraduationRule, title: string): string | undefined {
  return internshipRole(title) ? rule.internship : rule.fullTime;
}

export function profileConflicts(profile: Profile, context: Pick<SkillContext, "profile" | "preferences">): ProfileConflict[] {
  const conflicts: ProfileConflict[] = [];
  const preferences = markdownEntries(context.preferences);
  const find = (label: RegExp) => [...preferences].find(([key]) => label.test(key))?.[1];

  for (const { label, field, name } of choiceFields) {
    const written = find(label);
    // Authorization is per country now; the notes are about the U.S.
    const kept = field === "workAuthorization" || field === "sponsorship"
      ? authorizationAnswer(profile, "in the United States", field) || ""
      : field === "willingToRelocate" || field === "veteranStatus" ? profile[field] : "";
    if (!written || !kept) continue;
    const a = canonicalAnswer(field, kept);
    const b = canonicalAnswer(field, written);
    const known = answerChoices[field] as readonly string[];
    // Only two readable answers that differ are a contradiction.
    if (known.includes(a) && known.includes(b) && a !== b)
      conflicts.push({ field: name, extension: kept, markdown: written.slice(0, 120), file: "preferences.md" });
  }

  const home = find(/^home base/);
  if (home && profile.city && !home.toLowerCase().includes(profile.city.trim().toLowerCase()))
    conflicts.push({ field: "Home city", extension: [profile.city, profile.state].filter(Boolean).join(", "), markdown: home, file: "preferences.md" });

  // The latest education end date the extension has, against the markdown's
  // graduation date. A month is enough; days are rarely on both.
  const graduation = find(/^graduation$/);
  const ends = profile.education.map((row) => row.endDate.slice(0, 7)).filter((d) => /^\d{4}-\d{2}$/u.test(d)).sort();
  const written = graduation ? monthYear(graduation) : "";
  // With a rule by role, either of its dates agrees: the application picks.
  const rule = graduationRule(context.preferences);
  const allowed = [written, rule.internship, rule.fullTime].filter(Boolean);
  if (written && ends.length && !allowed.includes(ends.at(-1)!))
    conflicts.push({ field: "Graduation", extension: ends.at(-1)!, markdown: graduation!.slice(0, 60), file: "preferences.md" });

  const gpa = context.profile.match(/\bGPA\s*:?\s*(\d\.\d{1,3})\b/u)?.[1];
  const ownGPA = latestRow(profile.education.filter((row) => row.gpa?.trim()))?.gpa?.trim();
  if (gpa && ownGPA && Number(gpa) !== Number(ownGPA))
    conflicts.push({ field: "GPA", extension: ownGPA, markdown: gpa, file: "profile.md" });

  return conflicts;
}

export function conflictWarning(conflicts: ProfileConflict[]): string[] {
  if (!conflicts.length) return [];
  const list = conflicts.map((c) => `${c.field} (extension: ${c.extension}; ${c.file}: ${c.markdown})`).join("; ");
  return [
    `Your extension profile and your tailoring notes disagree. Form fields use the saved profile, and written drafts can draw on the notes. ${list}`.slice(0, 350),
  ];
}

// What a fill capture records of the profile it used, to tell later whether
// the profile has changed since: the saved revision and a fingerprint.
// The fingerprint is the SHA-256 (hex) of a stable JSON (keys sorted) of
// everything that can change an answer: the scalar fields, answers, legal
// details, standing answers and preferences, work, education, skills,
// languages, references, facts and role overrides. Left out: the revision
// itself, schemaVersion, applyingTo (the job, set per fill) and any
// createdAt/updatedAt timestamps, which change without changing an answer.
const NOT_ANSWERS = new Set(["revision", "schemaVersion", "applyingTo", "createdAt", "updatedAt"]);
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key, item]) => !NOT_ANSWERS.has(key) && item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}
export function profileFingerprint(profile: Profile): string {
  return createHash("sha256").update(JSON.stringify(stable(profile))).digest("hex");
}
export const profileStamp = (profile: Profile) => ({ revision: profile.revision, fingerprint: profileFingerprint(profile) });
