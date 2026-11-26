// Time zone questions ("Time Zone", "What time zone are you in?") answered
// from the profile's IANA zone id. The current offset comes from Intl, so
// daylight saving is followed; only the names people write are a table.
import { normalize } from "./model";

// Words a form uses for a zone: [strong names, weak names]. A strong name
// identifies the zone; a weak one ("Mountain") only its region.
const NAMES: Record<string, [string[], string[]]> = {
  "America/Phoenix": [["arizona", "phoenix", "mountain standard time", "mst"], ["mountain"]],
  "America/New_York": [["eastern standard time", "eastern daylight time", "new york", "est", "edt", "et"], ["eastern"]],
  "America/Detroit": [["eastern standard time", "eastern daylight time", "detroit", "est", "edt", "et"], ["eastern"]],
  "America/Chicago": [["central standard time", "central daylight time", "chicago", "cst", "cdt", "ct"], ["central"]],
  "America/Denver": [["mountain standard time", "mountain daylight time", "denver", "mst", "mdt", "mt"], ["mountain"]],
  "America/Los_Angeles": [["pacific standard time", "pacific daylight time", "los angeles", "pst", "pdt", "pt"], ["pacific"]],
  "America/Anchorage": [["alaska standard time", "alaska daylight time", "alaska", "akst", "akdt"], ["alaska"]],
  "Pacific/Honolulu": [["hawaii aleutian standard time", "hawaii standard time", "hawaii", "honolulu", "hst"], ["hawaii"]],
};

// Zones the profile editor lists first.
export const COMMON_TIME_ZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles",
  "America/Anchorage", "Pacific/Honolulu", "America/Toronto", "America/Vancouver", "America/Mexico_City",
  "America/Sao_Paulo", "Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Berlin", "Europe/Madrid",
  "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland", "UTC",
];

function validZone(zone: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
}

// Offset from UTC in minutes at a moment; undefined for an unknown zone.
export function zoneOffset(zone: string, at: Date): number | undefined {
  if (!validZone(zone)) return;
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(at).find(p => p.type === "timeZoneName")?.value || "";
    if (/^(GMT|UTC)$/.test(part)) return 0;
    const m = part.match(/^GMT([+\-−])(\d{2}):(\d{2})$/);
    return m ? (m[1] === "+" ? 1 : -1) * (Number(m[2]) * 60 + Number(m[3])) : undefined;
  } catch { return; }
}

export function offsetText(minutes: number, sign: "-" | "−" = "-"): string {
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? sign : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

function words(zone: string): { strong: string[]; weak: string[] } {
  const known = NAMES[zone];
  const city = zone.split("/").pop()!.replace(/_/g, " ").toLowerCase();
  return { strong: [...(known?.[0] || []), ...(zone.includes("/") && city.length > 2 ? [city] : [])], weak: known?.[1] || [] };
}

// A readable label for the editor: "Arizona — UTC−07:00 (America/Phoenix)".
export function timeZoneLabel(zone: string, at = new Date()): string {
  const offset = zoneOffset(zone, at);
  const name = zone === "UTC" ? "Coordinated Universal Time"
    : (zone === "America/Phoenix" ? "Arizona" : zone.split("/").pop()!.replace(/_/g, " "));
  return `${name} — UTC${offset === undefined ? "" : offsetText(offset, "−")} (${zone})`;
}

export function timeZoneChoices(): string[] {
  let all: string[] = [];
  try { all = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") || []; } catch { /* older engines */ }
  return [...COMMON_TIME_ZONES, ...all.filter(zone => !COMMON_TIME_ZONES.includes(zone))].filter(validZone);
}

export function timeZoneQuestion(label: string): boolean {
  const q = normalize(label).replace(/\btime zone\b/g, "timezone").replace(/\s+(required|optional)$/, "");
  return /^(what (is|s) |which |what )?(your )?(current |preferred |local |primary )?timezone( (are you in|do you (work|live|reside) in|you (are|work|live) in|preference|of residence))?$/.test(q);
}

// Offsets (minutes) a text states: "-07:00", "GMT-7", "UTC−07:00", "-0700".
// "Etc/GMT+7" is POSIX with the sign inverted, so it is read apart.
function statedOffsets(text: string): number[] {
  const found: number[] = [];
  const rest = text.replace(/etc\/gmt([+\-−])(\d{1,2})\b/gi, (_, sign: string, hours: string) => {
    found.push((sign === "+" ? -1 : 1) * Number(hours) * 60);
    return " ";
  });
  for (const m of rest.matchAll(/(?:^|[^\w])(?:(?:gmt|utc)\s*)?([+\-−–])\s*(\d{1,2})(?::?(\d{2}))?(?!\d)/gi)) {
    const hours = Number(m[2]);
    if (hours > 14) continue;
    found.push((/[-−–]/.test(m[1]) ? -1 : 1) * (hours * 60 + Number(m[3] || 0)));
  }
  if (!found.length && /\b(?:gmt|utc)\b/i.test(rest)) found.push(0);
  return found;
}

function hasWord(text: string, word: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${word.replace(/ /g, "[ _]+")}($|[^a-z0-9])`).test(text);
}

function optionScore(option: string, zone: string, offsets: number[]): number {
  const text = option.toLowerCase().replace(/[−–]/g, "-");
  const stated = statedOffsets(option);
  if (stated.length && !stated.some(o => offsets.includes(o))) return 0;
  if (text.includes(zone.toLowerCase())) return 100;
  const { strong, weak } = words(zone);
  const named = strong.some(w => hasWord(text, w));
  if (stated.length) return named ? 90 : 80;
  if (named) return 60;
  return weak.some(w => hasWord(text, w)) ? 30 : 0;
}

export function timeZoneAnswer(label: string, options: string[], zone: string, now = new Date()): { value: string; choices?: string[] } | undefined {
  if (!zone || !timeZoneQuestion(label)) return;
  const current = zoneOffset(zone, now);
  if (current === undefined) return;
  if (options.length) {
    let best: string | undefined, top = 0;
    for (const option of options) {
      const score = optionScore(option, zone, [current]);
      if (score > top) { best = option; top = score; }
    }
    return best ? { value: best } : undefined;
  }
  const { strong, weak } = words(zone);
  const title = (w: string) => w.replace(/\b\w/g, c => c.toUpperCase());
  const named = [...strong.filter(w => w.length > 3 && !/ time$/.test(w)).slice(0, 1), ...weak].map(title);
  return { value: zone, choices: [offsetText(current), ...named] };
}
