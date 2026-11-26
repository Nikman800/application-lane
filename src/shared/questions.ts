import { normalize, type Field, type LegalDetailKey } from "./model";
import { missingOptionalProfileField, profileFactQuestion } from "./profile-facts";
import { questionTopic } from "./standing";

const identity =
  /^(first|last|full|legal|preferred|middle|given|family)?\s*name\b|\be-?mail\b|\bphone\b|\bmobile\b|linkedin|github|\bwebsite\b|portfolio|\burl\b|\baddress\b|^(city|state|province|zip|postal|country)\b|twitter|behance|dribbble|pronoun|\bzip\b|postal code|post code|street|residen(ce|tial) address/i;
const neverWritten =
  /\bgender\b|\brace\b|ethnic|hispanic|latin[oax]|veteran|disabilit|sexual orientation|\bconsent\b|\bagree\b|signature|sign here|initials|certif|criminal|convict|felony|password|captcha|verification code|one.time/i;
const questionShaped =
  /\?\s*$|^\s*(what|why|how|when|where|which|who|describe|tell|explain|share|list|give|provide|please)\b/i;
// Never the model's to give, whatever the settings: secrets, signatures and
// attestations. Legal and eligibility questions are a separate, adjustable
// rule (legalQuestion below).
// (A "Degree Conferred" box takes a date the model can only guess at; it
// wrote a degree's name there, an employer.)
const manualOnly =
  /password|passcode|captcha|verification code|one.time|signature|sign here|initials|\bconsent\b|\bagree\b|certif|social security|\bssn\b|tax id|bank account|\b(degree|diploma) (conferred|received|awarded)\b/i;
export const logisticsQuestion =
  /salary|compensation|pay (expectation|requirement|range)|hourly (rate|pay)|start date|when can you start|availab|notice period|relocat|remote|on-?site|hybrid|work authori[sz]|sponsor|\bvisa\b/i;

// The Month box of a start date split in three after its question (Workday's
// "When are you available to start?: Month" beside Day and Year): one
// question, asked of the written answer once, for the Month box.
export function startDateMonth(field: Pick<Field, "label" | "kind" | "value" | "protected">): boolean {
  return (
    !field.protected &&
    !field.value.trim() &&
    ["spinbutton", "text", "number"].includes(field.kind) &&
    /(?:\?\s*:?|[.:]\s*:|\bdate\s*:|\bstart\??\s*:)\s*month\s*$/i.test(field.label) &&
    questionTopic(field.label) === "start"
  );
}

// The label a writer is asked for a field: the Month box of a split start
// date stands for the whole question, answered as a date or "Immediately"
// (asked as "…: Month", a model named a month and nothing else).
export function writerLabel(field: Pick<Field, "label" | "kind" | "value" | "protected">): string {
  if (!startDateMonth(field)) return field.label;
  return `${field.label.replace(/\s*:?\s*month\s*$/i, "")} (the whole start date: answer with a date as mm/dd/yyyy, or "Immediately")`;
}

export function applicationQuestion(field: Field): boolean {
  if (startDateMonth(field)) return true;
  if (field.protected || field.value.trim() || field.options.length)
    return false;
  if (!["textarea", "text"].includes(field.kind)) return false;
  if (profileFactQuestion(field)) return false;
  const label = field.label.trim();
  if (
    !label ||
    label === "Unlabelled field" ||
    neverWritten.test(label) ||
    // A legal or eligibility question, written explanations included, is
    // answered from the applicant's saved details by the suggestion step.
    legalQuestion(`${field.question || ""} ${label}`) ||
    /cover.?letter/i.test(label)
  )
    return false;
  // History rows use names such as "Education Information 1" and "Work
  // Experience 2". Narrative prompts may still mention work or education.
  if (
    /^(?:education(?: information| history| background)?|academic(?: information| history| background)?|school(?: information| history)?|work(?: experience| history| information)?|experience|employment(?: history| information)?)\s*(?:#?\d+)?$/i.test(
      field.section || "",
    )
  )
    return false;
  if (identity.test(label) && !logisticsQuestion.test(label)) return false;
  return (
    field.kind === "textarea" ||
    questionShaped.test(label) ||
    logisticsQuestion.test(label)
  );
}

// Empty structured controls that normal profile matching could not finish.
// Written responses have their own reviewed workflow; attestations and
// secret/financial fields always stay with the applicant, and so does a
// legal or eligibility question unless the applicant lets the model answer.
export function structuredFallbackField(field: Field, legalToo = false): boolean {
  if (field.protected || field.value.trim() || applicationQuestion(field))
    return false;
  if (profileFactQuestion(field) || missingOptionalProfileField(field)) return false;
  if (!legalToo && legalQuestion(`${field.question || ""} ${field.label}`)) return false;
  // "Education (Completed)" asks for the highest degree only and says to
  // remove all other rows: the model never fills a row after the first
  // (iCIMS: it copied the first school into a
  // second block and left its required Country empty).
  if (/\beducation\b/i.test(field.section || "") && /\bcompleted\b/i.test(field.section || "") && (field.index || 0) > 0) return false;
  if (
    manualOnly.test(field.label) ||
    /file|password|hidden|submit|button/.test(field.kind)
  )
    return false;
  // A box that adds one choice per search ("Type to Add Skills", Workday)
  // holds no written answer: a list typed into it was the model's, in the
  // wrong form. Its site rule picks each one.
  if (/^(type to (add|search)|search( for)?)\b/i.test(field.label.trim())) return false;
  // A job's or school's dates are the profile's, row by row: one it leaves
  // empty (an end date for a job still held) stays empty. The model, told
  // only "End Date" under "Previous employment", gave a current job another
  // job's end date (SuccessFactors).
  // A job's "I currently work here" and a school's "Still Student?" are the
  // profile's, row by row: ticked for the row held now, left unticked for one
  // that ended. A box left unticked reads as unanswered, and the model wrote
  // No over it (Workday, Paylocity, Ashby).
  if (rowCurrentBox(field)) return false;
  // Only an entry's own short date label in a section that names it:
  // Workday titles each question's section with the question itself, and
  // one employer's "Do you now, or did you … in the past 24 months, serve as an
  // official or employee of the DoD?" read as a job's date.
  if (
    (field.section || "").length <= 80 &&
    /education|academic|school|work|employment|experience/i.test(field.section || "") &&
    field.label.length <= 60 &&
    /\b(date|from|to|start|end|month|year)\b/i.test(field.label)
  )
    return false;
  // Fields the profile has nothing to say to: a social profile it holds no
  // address for, and the number of an employer's own staff. Each was sent to
  // the model, which answered none, 8 to 32 s a page while the fill waited
  // (Adatum). (A box asking for an employer, a site or GitHub is the
  // profile's own, and is still asked.)
  if (/^(facebook|twitter|x|x twitter|instagram|tiktok|snapchat|youtube|pinterest|reddit|twitch)( (url|link|profile|handle|username|page|account))?$/i.test(field.label.trim().replace(/[^a-z ]+/gi, " ").replace(/\s+/g, " ")) ||
      /^employee (id|number)\b/i.test(field.label.trim()) && !field.required)
    return false;
  // So is a school's GPA: one the profile leaves out is left out on purpose.
  // The model put one school's GPA on another (Workday).
  if (/\b(c?gpa|grade point)\b/i.test(field.label)) return false;
  return Boolean(field.label.trim() && field.label !== "Unlabelled field");
}

// A question whose answer is a statement about the applicant's legal
// standing or eligibility. A wrong answer is a false statement on an
// application, so by default the model never gives one: the applicant's
// saved profile answers it, or the applicant does.
const legalOrEligibility =
  /\b(convict\w*|felon\w*|misdemeano\w*|criminal\w*|arrest\w*|pending charges?|probation|parole|security clearance|clearance|polygraph|background (check|investigation)|drug (test|screen)\w*|non ?compete|non ?solicit\w*|restrictive covenant|confidentiality agreement|asked to resign|disciplinary action|disciplined|debar\w*|sanctioned|sanctions list|export control\w*|itar|conflicts? of interest|government (official|employee|agency)|public official|bankrupt\w*|lawsuit\w*|litigation|licen[cs]e (been )?(revoked|suspended))\b|\b(terminated|termination|fired|dismissed|discharged)\b.{0,60}\b(employ\w*|job|position|company)\b|\b(employ\w*|job|position)\b.{0,60}\b(terminated|termination|fired|dismissed|discharged)\b|\b(relatives?|family members?|related to (any|anyone|someone|an?|current|our|employees?))\b.{0,60}\b(work|works|working|employ\w*|company)\b|\b(work|employ)\w*\b.{0,40}\b(relatives?|family members?|related to (any|anyone|someone|an?|current|our|employees?))\b/;
export function legalQuestion(label: string): boolean {
  return legalOrEligibility.test(normalize(label));
}

// Which of the applicant's saved legal details (Profile.legal) a legal
// question asks about. An AI answer to it must stand on one of these, or on
// "Anything else": a saved clearance does not answer a question about a
// conviction. Empty when the question names none of them.
const legalTopicPatterns: [LegalDetailKey, RegExp][] = [
  ["criminal", /\b(convict\w*|felon\w*|misdemeano\w*|criminal\w*|arrest\w*|pending charges?|probation|parole)\b/],
  ["clearance", /\b(security clearance|clearance|polygraph)\b/],
  ["exportControl", /\b(export control\w*|itar|ear|u s person|us person)\b/],
  ["agreements", /\b(non ?compete|non ?solicit\w*|restrictive covenant|confidentiality agreement)\b/],
  ["terminations", /\b(terminated|termination|fired|dismissed|discharged|asked to resign|disciplinary action|disciplined)\b/],
  ["government", /\b(government (official|employee|agency)|public official|debar\w*|sanctioned|sanctions list)\b/],
  ["relatives", /\b(relatives?|family members?|related to)\b/],
  ["screening", /\b(background (check|investigation)|drug (test|screen)\w*)\b/],
];
export function legalTopics(label: string): LegalDetailKey[] {
  const text = normalize(label);
  return legalTopicPatterns.filter(([, pattern]) => pattern.test(text)).map(([key]) => key);
}

export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/u).length : 0;
}
export function wordLimit(text: string): number | undefined {
  const matches = [
    ...text.matchAll(
      /(?:max(?:imum)?\s*(?:word\s*count)?\s*(?:of|:)?\s*(\d[\d,]*)\s*words?|(\d[\d,]*)\s*[- ]?words?\s*(?:limit|max(?:imum)?)|word\s*limit\s*(?:of|:)?\s*(\d[\d,]*))/giu,
    ),
  ];
  const limits = matches
    .map((m) => Number((m[1] || m[2] || m[3]).replaceAll(",", "")))
    .filter((n) => n > 0 && n <= 10000);
  return limits.length ? Math.min(...limits) : undefined;
}
export function answerLimitError(
  text: string,
  field: Pick<Field, "maxLength" | "maxWords">,
): string | undefined {
  if (field.maxWords && wordCount(text) > field.maxWords)
    return `Use at most ${field.maxWords} words.`;
  const characters = Math.min(field.maxLength || 4000, 4000);
  if (text.length > characters) return `Use at most ${characters} characters.`;
}
// Keep complete sentences; never turn an oversized draft into a fragment.
export function fitAnswerLength(
  text: string,
  field: Pick<Field, "maxLength" | "maxWords">,
): string {
  if (!answerLimitError(text, field)) return text;
  let kept = "";
  for (const sentence of text.split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}"“])/u)) {
    const next = [kept, sentence].filter(Boolean).join(" ");
    if (answerLimitError(next, field)) break;
    kept = next;
  }
  return kept;
}

// Why the fill left a question, said in the panel's list of unfilled fields
// in place of "Normal fill could not match this field…", which read as a
// failure for questions it leaves on purpose (Woodgrove's attestations and
// legal questions). Undefined: no reason of its own.
export function leftReason(label: string): string | undefined {
  const text = label.toLowerCase();
  if (/\b(i (acknowledge|attest|certify|confirm|understand|agree)|acknowledg\w*|attest\w*|certif\w*|truthfully and accurately|signature|sign\w* (here|below)|e-?signature)\b/.test(text))
    return "An attestation or acknowledgment: yours to confirm. Application Lane never signs for you.";
  if (/\b(relatives?|family members?|close personal connections?|referred|know anyone)\b/.test(text))
    return "About people you know: yours to answer. Save an answer in your profile to reuse it.";
  if (/\b(debar\w*|suspended|government (employ\w*|official)|special government employee|armed (services|forces)|post-government|export control|criminal|convict\w*|felon\w*|security clearance|clearance|non-?compete|conflicts? of interest)\b/.test(text))
    return "A legal question your profile does not answer. Save an answer once in your profile, and every application will use it.";
  if (/\b(future positions|willing to travel|how often .*travel|preferred|preference|select one of the following options)\b/.test(text))
    return "A preference your profile does not record. Save an answer once in your profile, and every application will use it.";
  return undefined;
}

// The box a job or school row asks whether it is still held: Workday's "I
// currently work here", Paylocity's "Currently Working Here", Ashby's "Still
// Student?" (named by its id where its label is lost).
export function rowCurrentBox(field: Pick<Field, "label" | "kind">): boolean {
  if (field.kind !== "checkbox" && field.kind !== "radio" && field.kind !== "select") return false;
  const label = field.label.trim().toLowerCase().replace(/[^a-z_\- ]+/g, " ").replace(/\s+/g, " ").trim();
  return /^(i )?(currently work(ing)? (here|in this role)|am currently working (here|in this role)|currently (studying|enrolled)( here)?|still (a )?student)$|^_systemfield_(education|work)_history-iscurrent$/.test(label);
}
