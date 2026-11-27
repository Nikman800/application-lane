// Checking a draft against the profile: what it claims, names and leaves out, and the local draft written without a model.
// Split out of generation.ts as it was; generation.ts re-exports it.
import { type GenerationRequest, type Field, type Profile, type Narrative, type GenerationJob, sensitiveQuestion } from "../shared/model";
import { namedInOneEntry, sentences } from "./verify";
import { createHash } from "node:crypto";
import { shortLabel, applicationQuestion, screenAnswer } from "./answers";
import { writerLabel } from "../shared/questions";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { schoolNames } from "../shared/schools";


// What the drafting calls are told beyond the request itself. A request whose
// description is empty has no readable posting.
export type DraftRequest = GenerationRequest & {
  // false: the form has no cover letter field, so no letter is written.
  letter?: boolean;
  // The page's own text when it held no posting: not tailored from, but the
  // names on it (the company's) are not inventions.
  pageText?: string;
  // The applicant's own profile notes (the tailoring folder's profile.md),
  // which the letter writer reads: what it takes from them is no invention.
  background?: string;
};

// Product and proper names a span carries: words with a capital past the
// sentence's first word, a digit, an inner capital or a slash ("Claude API",
// "ElevenLabs", "vLLM/Ollama"). A span whose every such name is in the
// profile's own text is not one the checking model can fault for inventing a
// tool.
export function distinctiveTerms(span: string): string[] {
  const words = span.split(/\s+/u).map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter(Boolean);
  const terms: string[] = [];
  words.forEach((word, index) => {
    for (const part of word.split("/").filter(Boolean)) {
      const capital = /^\p{Lu}/u.test(part) && index > 0 && !/^I(?:'\p{L}+)?$/u.test(part);
      if (capital || /\d/u.test(part) || /\p{Ll}\p{Lu}/u.test(part) || word.includes("/")) terms.push(part);
    }
  });
  return terms;
}

// The same terms, all named in one entry of the profile that may vouch for
// them (namedInOneEntry, verify.ts).
export function foundInProfile(span: string, profileText: string): boolean {
  return namedInOneEntry(span, distinctiveTerms(span), profileText);
}

// A remainder that opens leaning on what was cut ("I've also used ...").
export function leansOnCutText(text: string): boolean {
  const first = sentences(text)[0] || "";
  return (
    /^\s*(?:(?:in addition|additionally|besides that|besides|on top of that|other than that|moreover|furthermore|also)\b|(?:this|these|that|those|it|they)\b)/iu.test(first) ||
    /^\s*(?:i|we)(?:'ve|'ll|'d|\s+have|\s+had)?\s+(?:also|additionally)\b/iu.test(first) ||
    /\b(?:as well|too)[.!?]*\s*$/iu.test(first)
  );
}

// "How many years of experience do you have in…" asks for a count. An
// answer that names none (its "0 years" taken out by the check, only the
// nearest other experience left) does not answer it (SuccessFactors). "Please input the total years of experience you
// have…" asks the same, and was left "Plus project and coursework experience".
export function namesNoDuration(question: string, answer: string): boolean {
  return /\bhow (many|much) (years|months)\b|\bhow long\b.*\bexperience\b|\b(total|number of) (years|months)\b|\byears of (\w+ ){0,2}experience (do )?you have\b/i.test(question) &&
    !/\b(\d+(\.\d+)?|no|zero|one|two|three|four|five|six|seven|eight|nine|ten|a few|several|a)\s*\+?\s*(full )?(years?|months?)\b|\bless than (a|one) year\b|\bnone\b|\bno (direct |related |directly related |professional )?experience\b/i.test(answer);
}

// A cover letter is written only for a form that takes one.
export function wantsLetter(fields: Field[]): boolean {
  return fields.some(
    (field) =>
      field.documentKind === "cover" ||
      /cover.?letter|motivation(al)? letter|letter of motivation/i.test(field.label),
  );
}

// Requirement vocabulary a job posting has and an application form or a
// cookie banner does not.
const postingVocabulary =
  /\b(responsibilit|qualification|requirement|what you( ll| will) (do|bring)|you will|we( re| are) looking|about (the|this) (role|team|position|job)|preferred|minimum|experience (with|in)|degree in|benefits)/giu;

// Whether the page's own text holds a job posting once the form's own
// labels are taken out of it: a long application form passes a bare word
// count, and its labels read like requirements.
export function postingReadable(request: GenerationRequest): boolean {
  const plain = (text: string) => ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
  let text = plain(request.description);
  for (const label of request.fields
    .map((field) => plain(field.label).trim())
    .filter((label) => label.length >= 3)
    .sort((a, b) => b.length - a.length))
    while (text.includes(` ${label} `)) text = text.replaceAll(` ${label} `, " ");
  const words = text.match(/\p{L}+/gu)?.length || 0;
  const vocabulary = new Set((text.match(postingVocabulary) || []).map((hit) => hit.toLowerCase()));
  return words >= 150 && vocabulary.size >= 2;
}

// A sentence that only says which role or dates the previous one happened in
// ("That work was my AI/ML Software Engineer internship.", "I did this as an
// intern."): the role is on the resume, and alone it reads as an orphan.
const orphan =
  /^((that|this|it)( (work|project|internship|role|job))? (was|ran)|i did (this|that) (as|during|at))\b(?=[^.!?]*\b(internship|intern|role|position|job|(19|20)\d{2})\b)[^.!?]*[.!?]$/iu;
// Text as it goes into a document: no orphan sentences, and the R² a PDF's
// text layer flattens to "R 2" written as R² again.
// Line by line, so an answer written as bullets keeps them.
export function tidyProse(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}"“])/u)
        .filter((sentence) => !(orphan.test(sentence.trim()) && sentence.split(/\s+/u).length <= 14))
        .join(" "),
    )
    .filter((line, index, lines) => line.trim() || (index > 0 && lines[index - 1].trim()))
    .join("\n")
    .replace(/\bR ?2(?=\s*[~∼≈]?\s*0?\.\d)/gu, "R²")
    .trim();
}

// A question as a repeat fill asks it again: its words without case, spacing
// or a required mark, and its limits (a shorter box takes a shorter answer).
// A field's id may differ between fills of the same page; its question not.
// A key for what an application's documents are made from. Every saved
// answer bumps the profile's revision, and none of them is in a document.
export function documentsKey(profile: Profile): string {
  const { revision: _revision, answers: _answers, ...rest } = profile;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex");
}
export function questionKey(field: Field) {
  // Keyed by the question the writer was asked (writerLabel): a split start
  // date's month named alone is not an answer to the whole date.
  const words = writerLabel(field).toLowerCase().replace(/\(required\)/gu, " ").replace(/[*\s]+/gu, " ").trim();
  return JSON.stringify([words, field.maxLength ?? null, field.maxWords ?? null, field.maxSentences ?? null]);
}

// Lines that say drafts went out unchecked: they hold for every answer.
const UNCHECKED = /^(A second model could not check|No other model in your Drafting order could check|A second model questioned every answer)\b/u;

// The answers a job delivered, as a repeat fill finds them (see the reuse in
// run): each with the lines about it, and those that say it was not checked.
// A question left for the applicant is not among them and is drafted again.
export function answeredRecord(fields: Field[], answers: Narrative["answers"], warnings: string[]): GenerationJob["answered"] {
  const unchecked = warnings.filter((warning) => UNCHECKED.test(warning));
  return answers.flatMap((answer) => {
    const field = fields.find((candidate) => candidate.id === answer.fieldId);
    if (!field) return [];
    const own = warnings.filter((warning) => !warning.startsWith("Left ") && warning.includes(`"${shortLabel(field.label)}"`));
    return [{ question: questionKey(field), value: answer.value, factIds: answer.factIds, warnings: [...unchecked, ...own] }];
  });
}

// Each warning once, and one per question left for the applicant (the first
// reason given), within the card's ten.
export function distinctWarnings(warnings: string[] = []): string[] | undefined {
  const seen = new Set<string>();
  const kept = warnings.filter((warning) => {
    const key = warning.match(/^Left "[^"]*"/u)?.[0] || warning;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return kept.length ? kept.slice(0, 10) : undefined;
}

// Every free-text question a form asks (see applicationQuestion). Without
// the job-applier preferences there is nothing to answer logistics from, so
// those stay with the applicant here.
export function narrativeField(field: Field) {
  return applicationQuestion(field) && !sensitiveQuestion.test(field.label);
}

// Questions about the applicant's own reasons, hopes and goals. Pasted
// resume facts never answer these ("Why are you interested in this
// position?" is not a list of bullets), so only a written answer may.
export function opinionQuestion(label: string): boolean {
  return /\bwhy\b|\binterest(ed|s)? (in|you)\b|\bexcit|\battract|\bpassion|\bmotivat|\bdrawn to\b|\bhope\b|\bgoals?\b|\baspir|\blooking for\b|\bwhat makes you\b|\b(want|like) to (join|work)\b/i.test(
    label,
  );
}

// Models like to cite in the prose ("…low-latency delivery (f23, f24)").
// The markers are ours, never the applicant's words, so they come out; text
// that still reads as machinery afterwards is not prose at all.
export function prose(raw: string): string | undefined {
  const text = raw
    .replace(/\s*[([]\s*[fq]\d{1,3}(?:\s*,\s*[fq]\d{1,3})*\s*[)\]]/gu, "")
    .replace(/\s+([.,;:])/gu, "$1")
    .trim();
  return text && !/\b[fq]\d{1,3}\b/u.test(text) ? text : undefined;
}

// The model ranks evidence. Factual language in published artifacts is taken
// from confirmed facts, never accepted merely because an LLM cites a fact ID.
// Every employer, product, technology, metric or date a written letter names
// must already appear in the applicant's confirmed facts or in the posting it
// answers. Anything else is the model inventing a credential, so it is named
// for the applicant rather than quietly attached. Ordinary prose is not
// checked: only claim-shaped words, which is what a fabrication looks like.
const openers = new Set(
  (
    "i my me we our the a an this that these those as at in on of for with to and " +
    "but so if when while during after before over through since dear hiring team " +
    "thank thanks sincerely regards best building working leading recently " +
    "currently most please it they he she there here such both each having beyond " +
    "across within alongside from by about under between throughout later then " +
    "today drawn excited eager keen able ready similarly likewise additionally its " +
    "moreover however furthermore finally overall meanwhile together whether " +
    "where what which who why how these those beyond outside alongside " +
    // Letters that vary how sentences open start them with these, which the
    // word list also has capitalised as surnames.
    "good much many every another other some all one long young"
  ).split(" "),
);
// Generic computing vocabulary that happens to be capitalised. Naming one of
// these is not claiming a credential, so they are not worth an alert.
const commonplace = new Set(
  (
    "api apis ui ux cpu gpu gpus os sdk ide ci cd http https rest json xml csv " +
    "pdf sql nosql url urls ai ml llm llms nlp db etl saas mvp qa tdd oop crud " +
    "ide vr ar xr ide ram ssd tcp ip dns cdn"
  ).split(" "),
);
// Hyphens and dashes are separators on both sides of the comparison: the
// facts say "chatbot–CRM" with an en dash where a letter writes "chatbot-CRM",
// and only the claim-shaped part of a compound is a claim at all.
const tokens = (text: string) =>
  (text.match(/[\p{L}\p{N}][\p{L}\p{N}.#+'’/%-]*/gu) || [])
    .flatMap((token) => token.split(/[-–—/]+/u))
    .filter(Boolean);
// "Klaviyo's" is the same claim as "Klaviyo", and "I've" is not a claim.
const normalize = (token: string) =>
  token
    .toLowerCase()
    .split(/['’]/u)[0]
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}#+]+$/gu, "");
// The same figure is written many ways: a fact's "900M+ conversations" is the
// letter's "900 million", and "12,700+" is "12700".
// "76%" and the profile's "76.0%" are one figure, as are "0.50" and "0.5".
const figure = (token: string) =>
  /\d/u.test(token) ? token.replace(/[^\d.]/gu, "").replace(/\.+$/u, "").replace(/(\.\d*?)0+$/u, "$1").replace(/\.$/u, "") : "";
// A sentence capitalises its first word, so "Improving response times…" is
// the facts' "Improved", not a name. Only such plain sentence-initial words
// are compared by stem; "Initech" or "Kubernetes" match nothing either way.
const stem = (token: string) =>
  token.length > 5 ? token.replace(/(ing|ed|es|ions?|ment|ly|s)$/u, "") : token;
const months = [
  ["jan", "january"], ["feb", "february"], ["mar", "march"], ["apr", "april"],
  ["jun", "june"], ["jul", "july"], ["aug", "august"], ["sep", "september"],
  ["sept", "september"], ["oct", "october"], ["nov", "november"], ["dec", "december"],
] as const;
// Ordinary English words, from the system word list: those it has only in
// lower case. "Taking", "Second" or "Measure" opening a sentence are words,
// not names; "Google" (also listed capitalised) and "Initech" (absent) are
// still claims. Windows and bare containers have no system list, and with
// none every such opener was a claim and its answer was left unwritten: the
// same list (Debian's wamerican, see words/COPYRIGHT) is kept beside this
// file for them.
let ordinary: Set<string> | undefined;
function ordinaryWords(): Set<string> {
  if (ordinary) return ordinary;
  ordinary = new Set();
  for (const path of ["/usr/share/dict/words", "/usr/share/dict/american-english", fileURLToPath(new URL("./words/american-english", import.meta.url))]) {
    let list: string[];
    try {
      // A Windows checkout may hold the packaged list with CRLF line ends.
      list = readFileSync(path, "utf8").split(/\r?\n/);
    } catch {
      continue;
    }
    const capitalised = new Set(
      list.filter((word) => /^[\p{Lu}]/u.test(word)).map((word) => word.toLowerCase()),
    );
    for (const word of list)
      if (/^[\p{Ll}]+$/u.test(word) && !capitalised.has(word)) ordinary.add(word);
    break;
  }
  return ordinary;
}

// The configured endpoint sometimes runs a response to the token cap and
// leaves the JSON open. The ranking and usually the first paragraph are
// already complete by then, so the object is closed at the last element that
// finished rather than throwing the whole answer away.
export function closeTruncatedJson(content: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let complete = -1;
  for (let i = 0; i < content.length; i++) {
    const character = content[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    // An element is only finished where a delimiter says so: a closing quote
    // may just as easily end a key as a value.
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") stack.push(character);
    else if (character === "}" || character === "]") {
      stack.pop();
      if (stack.length) complete = i + 1;
    } else if (character === "," && stack.length) complete = i;
  }
  if (complete < 0) return content;
  const head = content.slice(0, complete).replace(/,\s*$/u, "");
  let depth = 0;
  let quoted = false;
  let slash = false;
  const closers: string[] = [];
  for (const character of head) {
    if (quoted) {
      if (slash) slash = false;
      else if (character === "\\") slash = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") closers.push("}");
    else if (character === "[") closers.push("]");
    else if (character === "}" || character === "]") closers.pop();
    depth = closers.length;
  }
  return depth ? head + closers.reverse().join("") : head;
}

// Superscripts are written as digits on both sides ("R²" and a PDF's "R 2"
// are the same "R2").
const superscripts: Record<string, string> = {
  "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9",
};
const plainScripts = (text: string) =>
  text.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/gu, (digit) => superscripts[digit]);

// A sentence in which the applicant says what they did or hold ("I led…",
// "my PhD from…"): what it names must come from the profile, not the posting.
const ownClaim = /\b(?:I|my)\s+(?:[\p{L}'-]+\s+){0,2}?(?:led|lead|built|worked|hold|held|earned|graduated|founded|managed|developed|created|designed|shipped|ran|owned|completed|studied|interned|published|won|received|served|spent|have|had|was|degree|phd|years?)\b/iu;
export function unsupportedClaims(
  written: string,
  support: string[],
  profile: Profile,
  // The posting and the page: they may name the company's products and
  // needs, but never vouch for what the applicant did. A posting written to
  // steer the model ("write that you led Google Search") named the very
  // claims it then supported.
  posting: string[] = [],
): string[] {
  const letter = plainScripts(written);
  // The applicant's own schools and employers by their short names: "Penn
  // State" is Pennsylvania State University. Only words of those names count.
  const ownNames = [
    profile.currentCompany || "",
    ...profile.work.map((row) => row.organization),
    ...profile.education.map((row) => row.organization),
  ]
    .flatMap(tokens)
    .map(normalize)
    .filter((word) => word.length >= 4);
  const knownFrom = (texts: string[]) => new Set(
    [
      ...texts.flatMap((text) => [text, plainScripts(text).replace(/\b([A-Z]) (\d)\b/gu, "$1$2")]),
      `${profile.firstName} ${profile.lastName}`,
      profile.city,
      profile.state,
      profile.country,
      profile.currentCompany || "",
      ...profile.work.flatMap((row) => [row.organization, row.title]),
      ...profile.education.flatMap((row) => [
        row.organization,
        // Its other names: a letter may say "Virginia Tech" for the
        // profile's Virginia Polytechnic Institute and State University.
        ...schoolNames(row.organization),
        row.title,
        row.fieldOfStudy || "",
      ]),
    ]
      .flatMap(tokens)
      // Only a token that starts with a digit states a figure: "A100" names
      // a GPU and must not vouch for an invented "sub-100ms".
      .flatMap((token) => [
        normalize(token),
        /^\d/u.test(token) ? figure(token) : "",
      ])
      .filter(Boolean),
  );
  const known = knownFrom([...support, ...posting]);
  const own = knownFrom(support);
  // A name the facts write out is known by its initials too: "UP" is University
  // Park (one employer's letter), "MSU" Michigan State University.
  const withInitials = (set: Set<string>, texts: string[]) => {
    for (const text of [
      ...texts,
      ...profile.work.map((row) => row.organization),
      ...profile.education.map((row) => row.organization),
    ])
      for (const run of text.match(/\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)+/gu) || []) {
        const initials = run.split(/\s+/u).map((word) => word[0].toLowerCase());
        for (let start = 0; start < initials.length - 1; start++)
          for (let end = start + 2; end <= Math.min(initials.length, start + 5); end++)
            set.add(initials.slice(start, end).join(""));
      }
    // "Mar 2025" in the facts and "March 2025" in the prose are one date.
    for (const [short, long] of months)
      if (set.has(short) || set.has(long)) set.add(short).add(long);
  };
  withInitials(known, [...support, ...posting]);
  withInitials(own, support);
  const stems = new Set([...known].map(stem));
  const missing: string[] = [];
  // Sentence starts capitalise ordinary words, so they are judged differently
  // from a capitalised word in the middle of a sentence.
  for (const sentence of letter.split(/(?<=[.!?])\s+|\n+/u)) {
    const words = tokens(sentence);
    const vouched = posting.length && ownClaim.test(sentence) ? own : known;
    for (const [index, raw] of words.entries()) {
      const token = normalize(raw);
      if (!token || token.length < 2 || vouched.has(token)) continue;
      if (commonplace.has(token)) continue;
      // "Network" where the facts say "Networks", and the reverse.
      if (vouched.has(`${token}s`) || (token.endsWith("s") && vouched.has(token.slice(0, -1)))) continue;
      if (token.length >= 3 && /^[\p{Lu}][\p{Ll}]+$/u.test(raw) && ownNames.some((word) => word.startsWith(token)))
        continue;
      const written = figure(raw);
      if (written && vouched.has(written)) continue;
      if (
        index === 0 &&
        /^[\p{Lu}][\p{Ll}]+$/u.test(raw) &&
        (stems.has(stem(token)) || ordinaryWords().has(token))
      )
        continue;
      const shaped =
        /\d/u.test(raw) ||
        /^[\p{Lu}]{2,}$/u.test(raw) ||
        /[\p{Lu}]/u.test(raw.slice(1)) ||
        /[\p{L}\p{N}][.#+][\p{L}\p{N}]/u.test(raw) ||
        (/^[\p{Lu}]/u.test(raw) && (index > 0 || !openers.has(token)));
      if (!shaped || missing.includes(raw)) continue;
      missing.push(raw);
      if (missing.length >= 6) return missing;
    }
  }
  return missing;
}

// What a written answer names that the profile does not support, in two
// kinds: invented (in neither the profile nor the posting), which leaves the
// answer to the applicant; and taken from the posting as the applicant's own
// experience ("I built payment systems like Acme Pay"), which is filled with a
// warning, as a letter is: the posting may have asked for it, or the answer
// may only be linking the applicant's work to the employer's.
export function answerClaims(text: string, support: string[], profile: Profile, posting: string[]) {
  const invented = unsupportedClaims(text, [...support, ...posting], profile);
  const fromPosting = unsupportedClaims(text, support, profile, posting).filter((name) => !invented.includes(name));
  return { invented, fromPosting };
}
export const postingClaimWarning = (label: string, names: string[]) =>
  `"${label}": the answer names ${names.join(", ")} as your own experience, which only the posting mentions and your confirmed facts do not support. Read it before submitting.`.slice(0, 350);

// The job-apply skill greets the company by name. The tracker's name may be
// a URL slug ("doordashusa", "acme") or "Application", so it is used only when
// the posting itself writes it as a name, and in the posting's spelling.
export function greetingCompany(
  request: Pick<GenerationRequest, "company" | "title" | "description"> & { pageText?: string },
): string {
  const name = (request.company || "").replace(/\s+/gu, " ").trim();
  if (name.length < 2 || /^application$/iu.test(name)) return "";
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  // Without a posting, the application page itself ("…your career at an employer")
  // still names the company.
  const written = `${request.title}\n${request.description}\n${request.pageText || ""}`.match(
    new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu"),
  )?.[0];
  return written && /^[\p{Lu}\p{N}]/u.test(written) ? written.slice(0, 80) : "";
}

// The share of a letter's sentences that open with "I": past half, the employer's letter read as a list of accomplishments.
export function iOpened(text: string): number {
  const all = sentences(text);
  return all.length < 6 ? 0 : all.filter((sentence) => /^I(?:'[a-z]+)?\b/u.test(sentence)).length / all.length;
}

const cliches = /\b(passionate|team player|hit the ground running|from day one|track record|fast learner|outside the box|synergy|results-driven|detail-oriented|perfect candidate|great fit|I am writing to|I would love the opportunity)\b/giu;
// Of a few drafts of one letter, the one with the lowest score goes out: a
// name or figure the applicant's facts do not hold costs most, then a
// letter of "I did" sentences, then one too short, too long or misshapen.
export function letterPenalty(paragraphs: string[], unsupported: number): number {
  const text = paragraphs.join(" ");
  const words = text.split(/\s+/u).filter(Boolean).length;
  return (
    unsupported * 10 +
    Math.max(0, iOpened(text) - 1 / 3) * 12 +
    (words < 200 ? (200 - words) / 25 : words > 400 ? (words - 400) / 25 : 0) +
    (paragraphs.length < 3 || paragraphs.length > 5 ? 3 : 0) +
    (text.match(cliches)?.length || 0) * 2
  );
}

export function groundNarrative(
  candidate: Narrative,
  profile: Profile,
  request: DraftRequest,
): Narrative {
  const letter = request.letter !== false;
  const facts = new Map(profile.facts.map((f) => [f.id, f.text]));
  const get = (id: string) => {
    const text = facts.get(id);
    if (!text)
      throw new Error("Generation referenced an unknown profile fact.");
    return text;
  };
  const selected = [...new Set(candidate.resume.map((f) => f.factId))];
  const coverFacts = [
    ...new Set(candidate.coverLetter.flatMap((p) => p.factIds)),
  ].slice(0, 8);
  // Written paragraphs are used as they stand, once every checkable claim in
  // them is traceable to the applicant's confirmed facts or the posting. The
  // greeting and closing are ours, never the model's.
  const written = candidate.coverLetter.filter((p) => p.text.trim());
  // An assembled letter is nothing without facts to assemble; a written one
  // carries its own body and may legitimately cite none.
  if (!selected.length || (letter && !written.length && !coverFacts.length))
    throw new Error("Generation did not select supporting facts.");
  const title = request.title.replace(/[\r\n]/g, " ").slice(0, 180);
  const company = greetingCompany(request);
  const greeting = company
    ? `Dear ${company} Hiring Team,`
    : "Dear Hiring Team,";
  const unsupported = written.length
    ? unsupportedClaims(
        written.map((p) => p.text).join("\n"),
        [
          ...profile.facts.map((f) => f.text),
          request.title,
          request.company || "",
          request.background || "",
        ],
        profile,
        [request.description, request.pageText || ""],
      )
    : [];
  const body = written.length
    ? written.map((p) => ({
        // The job-apply skill writes no em dashes: a comma reads the same.
        text: tidyProse(p.text.trim().replace(/\s*—\s*/gu, ", ")).slice(0, 3000),
        factIds: [...new Set(p.factIds)].filter((id) => facts.has(id)),
      }))
    : coverFacts.map((id) => ({ text: get(id), factIds: [id] }));
  const coverLetter = !letter ? [] : [
    {
      text: written.length
        ? greeting
        : `${greeting}\n\nI am applying for ${title || "the advertised opportunity"}. The following experience from my background is relevant to my application.`,
      factIds: [] as string[],
    },
    ...body,
    // A written letter closes itself; only the assembled one needs this.
    ...(written.length
      ? []
      : [
          {
            text: "I would welcome the opportunity to discuss how this experience could contribute to your team.",
            factIds: [] as string[],
          },
        ]),
  ];
  const seen = new Set<string>();
  const support = [
    ...profile.facts.map((f) => f.text),
    request.title,
    request.company || "",
  ];
  const posting = [request.description, request.pageText || ""];
  const answerWarnings: string[] = [];
  const answers = candidate.answers.flatMap((answer) => {
    const field = request.fields.find((f) => f.id === answer.fieldId);
    if (!field || seen.has(field.id) || !narrativeField(field)) return [];
    seen.add(field.id);
    // Without the posting there is nothing to say why from.
    if (!request.description.trim() && opinionQuestion(field.label)) return [];
    const drafted = answer.value.trim();
    const screened = drafted ? screenAnswer(field.label, drafted) : { text: "" };
    if ("reason" in screened) {
      answerWarnings.push(`Left "${shortLabel(field.label)}" for you: ${screened.reason}.`.slice(0, 350));
      return [];
    }
    const written = screened.text;
    if (written) {
      // A written answer stands only when every checkable claim in it is in
      // the applicant's confirmed facts or the posting. One that names
      // anything else is left for the applicant; one that claims the
      // posting's names as the applicant's own is filled with a warning
      // (answerClaims).
      const cited = [...new Set(answer.factIds)]
        .filter((id) => facts.has(id))
        .slice(0, 3);
      if (!cited.length) return [];
      const { invented, fromPosting } = answerClaims(written, support, profile, [...posting, field.label]);
      if (invented.length) {
        answerWarnings.push(
          `Left "${shortLabel(field.label)}" for you: the drafted answer mentioned ${invented.join(", ")}, which your confirmed facts do not support.`.slice(
            0,
            350,
          ),
        );
        return [];
      }
      if (fromPosting.length) answerWarnings.push(postingClaimWarning(shortLabel(field.label), fromPosting));
      return [
        { fieldId: field.id, value: written.slice(0, 2000), factIds: cited },
      ];
    }
    // Pasted facts can answer "describe your experience", never "why this
    // role": an opinion question without a written answer stays empty.
    if (opinionQuestion(field.label)) return [];
    const factIds: string[] = [];
    let size = 0;
    for (const id of new Set(answer.factIds)) {
      const text = get(id);
      if (size + text.length + factIds.length > 4000) continue;
      factIds.push(id);
      size += text.length;
    }
    if (!factIds.length) return [];
    return [
      {
        fieldId: field.id,
        value: factIds.map(get).join("\n"),
        factIds,
      },
    ];
  });
  const warnings = [
    ...(candidate.warnings || []),
    ...(unsupported.length
      ? [
          `The cover letter mentions ${unsupported.join(", ")}, which your confirmed facts do not support. Read it before submitting.`.slice(
            0,
            350,
          ),
        ]
      : []),
    ...answerWarnings,
    ...(letter && written.length === 1
      ? [
          "The cover letter came back as a single paragraph. Read it before submitting.",
        ]
      : []),
    ...(letter && iOpened(written.map((p) => p.text).join(" ")) > 0.5
      ? ['Most of the cover letter\'s sentences start with "I", so it reads like a list. Read it before submitting.']
      : []),
  ].slice(0, 10);
  return {
    ...(warnings.length ? { warnings } : {}),
    resume: selected.map((factId) => ({ factId, text: get(factId) })),
    coverLetter,
    answers,
  };
}

export const RESUME_LIMIT = 24;
export const COVER_LIMIT = 4;
export const ANSWER_LIMIT = 20;
export const RECOVERED =
  "AI response was incomplete or contained unusable selections. Drafts were repaired using confirmed facts only; review their relevance before continuing.";
export const UNRANKED =
  "The AI returned an unranked selection, so the most relevant confirmed facts were chosen locally. Check that the resume evidence fits this job.";
export const LOCAL_DRAFT =
  "Local fallback draft: AI tailoring was unavailable. Facts were selected by keyword overlap, not AI; review the resume and cover letter. Narrative questions remain manual.";

// Stable keyword ranking is a recovery path, not a claim of AI-quality tailoring.
export function rankedFacts(
  profile: Profile,
  request: GenerationRequest,
  within?: Set<string>,
) {
  const words = (text: string) =>
    new Set(text.toLowerCase().match(/[\p{L}\p{N}+#.]{3,}/gu) || []);
  const title = words(request.title);
  const description = words(request.description);
  return profile.facts
    .filter((fact) => !within || within.has(fact.id))
    .map((fact, index) => ({
      fact,
      index,
      score: [...words(fact.text)].reduce(
        (score, word) =>
          score + (title.has(word) ? 3 : 0) + (description.has(word) ? 1 : 0),
        0,
      ),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, RESUME_LIMIT)
    .map(({ fact }) => fact);
}

export function localDraft(
  profile: Profile,
  request: DraftRequest,
  reason: string,
): Narrative {
  const selected = rankedFacts(profile, request);
  return groundNarrative(
    {
      resume: selected.map((f) => ({ factId: f.id, text: "" })),
      coverLetter: [
        { text: "", factIds: selected.slice(0, COVER_LIMIT).map((f) => f.id) },
      ],
      answers: [],
      warnings: [reason, LOCAL_DRAFT],
    },
    profile,
    request,
  );
}

export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
