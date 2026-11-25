// Part of the content script (content.ts): the content script's shared mutable state, one object every part reads and writes.
// Split out of content.ts as it was; see content.ts for how it starts.
import { configuredFileControls, configuredRadioControls } from "../../engine/runtime";
import { startRecorder } from "../recorder";

export const cs = {
  // Real keys this extension is sending, and for a moment after the last lands:
  // a key event then is its own, whichever box it reaches and whatever the
  // applicant did a moment before. Counted only by the element being typed
  // into, the fill paused on its own keys twice (Woodgrove's Workday, a key
  // on "From: Month" after a window switch, and on its export-control list).
  keysInFlight: 0,
  keysSettleUntil: 0,
  // The element the extension's own real keys go to (requestTrustedType).
  keysTarget: undefined as Element | undefined,
  wakePort: undefined as chrome.runtime.Port | undefined,
  wakeCount: 0,
  fileControls: new Map<HTMLElement, ReturnType<typeof configuredFileControls>[number]>(),
  radioControls: new Map<HTMLElement, ReturnType<typeof configuredRadioControls>[number]>(),
  paused: false,
  // When the applicant last pressed, typed or touched anything on the page.
  lastApplicantInput: -Infinity,
  // The event that paused the fill and the control it landed on, for the
  // card: "You interacted" alone cannot be told from a false alarm.
  pausedBy: "",
  applicationId: "",
  replaceSiteValues: false,
  // Values this extension wrote on the application's pages before (see
  // Application.ownWrites): a field still holding one is not the applicant's.
  ownWrites: [] as import("../../shared/model").OwnWrite[],
  // Until when value changes nobody made by hand are the site filling the
  // form from an uploaded resume (set when such an upload is attached).
  siteFillUntil: 0,
  operation: -1,
  configController: new AbortController(),
  stopRecording: undefined as ReturnType<typeof startRecorder> | undefined,
  recordingSession: "",
  configPass: "",
  // The pass already tried a second time after it failed or ran out of time.
  configRetried: "",
  // The cautions of the last pass (a closest pick): a repeat of the pass
  // skips its work, and without them the review list would lose them.
  configCautions: [] as { key: string; status: "filled"; caution: string }[],
  writing: false,
  // The element a burst of real keystrokes is landing in, while it is in
  // flight. Nothing else is exempt from the user-edit rules.
  trustedWrite: undefined as Element | undefined,
  // A search box our real Enter searched: the site answers on its own a
  // moment later, moving focus into its results, and the box's trusted
  // input or change that follows is still ours (one employer's field of study paused
  // the fill as the applicant's edit). Only those two events,
  // only on that box, only briefly, and never while the applicant is active.
  searchSettle: undefined as { element: Element; until: number } | undefined,
  applicantGesture: -Infinity,
  applicantControl: undefined as Element | undefined,
  // Our keys that reached another field. A page without focus gets it from
  // our first key, and only then runs its focus handlers: Workday's sends a
  // date's Year back to Month after the check before typing had passed. The
  // rest of the burst is kept from the page, so it neither edits Month nor
  // reads as the applicant's key press, and the field is typed again.
  // A key's release is not counted: Workday moves focus to Year as soon as
  // Month holds two digits, so the last key's release lands there, as it does
  // for the applicant. Counted, the month was retyped and then assigned, and
  // Workday dropped the assigned month.
  misdirected: false,
  // A real click the fill is making on a menu's entry, at a point of the
  // window, while it is in flight and for a moment after. The debugger
  // clicks wherever that point is when the press arrives: a menu that
  // closed or moved in between left another box there, and SmartRecruiters'
  // Company pick clicked into the City box above it, which paused the fill
  // as the applicant's "click on City" (Veolia). Such a click, at exactly the fill's point, is kept from the
  // page and tried again; anywhere else it is the applicant's.
  ownClickAt: undefined as { x: number; y: number; target: Element; until: number; missed: boolean } | undefined,
  ownedActivation: undefined as | { control: HTMLInputElement; events: Set<string> }
    | undefined,
  composing: false,
  lastFingerprint: "",
  // Every field id an inspection has listed: a required empty one not in it
  // is a question the page drew after the fill (the applicant's own pick).
  seenFields: new Set<string>(),
  // The set of such fields last announced, so each set is announced once.
  announcedFresh: "",
  autoDocumentMutation: false,
  savesFinished: 0,
  // When the fill last wrote, started or finished, and where: see the site
  // answering a write below.
  lastEngineWrite: -Infinity,
  lastWritten: undefined as Element | undefined,
  // SuccessFactors marks a picklist closed on its Escape but leaves the list
  // drawn over the form; a press elsewhere on the page takes it away, as the
  // applicant's own click did (an employer recordings: of 556
  // Escapes sent while a list showed, none took it away).
  lastLanePicklistClick: 0,
  lastApplicantPicklistUse: 0,
  boxesWanted: { operation: -1, boxes: new Map() } as { operation: number; boxes: Map<HTMLInputElement, { element: HTMLInputElement; wanted: boolean; fieldId: string }> },
  pageTimersOn: false,
  pumpingPageTimers: false,
  // Checked a moment after a list is drawn, on this script's own clock (a
  // hidden page's timers are slowed).
  unaskedCheck: false,
  sessionCheck: false,
  sessionToldExpired: false,
  // The site's own confirmation that the application went in (its page after
  // Submit, or a banner drawn in place): said once, so the applicant does not
  // have to mark it submitted. Nothing here presses Submit.
  toldSubmitted: false,
  toldApplied: false,
  toldByWords: false,
  submittedTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
};
