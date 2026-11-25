// Part of the extension's service worker (background.ts): the worker's shared mutable state, one object every part reads and writes.
// Split out of background.ts as it was; see background.ts for how it starts.
import { type QueueState } from "../../shared/model";

export const bg = {
  state: {
    schemaVersion: 2,
    applications: [],
    settings: { concurrency: 4, generationConcurrency: 2 },
  } as QueueState,
  locks: {} as Record<string, string[]>,
  token: "",
  saving: Promise.resolve(),
  kickTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  pumping: false,
  // The queue as the command line sees it (scripts/lane.ts): mirrored to the
  // backend as it changes, since it lives here. A change after a quiet spell
  // goes at once, then at most one every two seconds: never two seconds after
  // the last change, since a fill saves its progress more often than that and
  // the command line saw "Tracked" until it stopped.
  syncTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  syncAgain: false,
  // The live line to the backend (src/server/live.ts): the command line's
  // "fill this step" and "switch to its tab" arrive at once, and the queue goes
  // out as it changes. Held open, it also keeps Chrome from putting this worker
  // to sleep, so a command never waits for the 30-second wake-up.
  live: undefined as WebSocket | undefined,
  liveRetry: 1000,
  liveBeat: undefined as ReturnType<typeof setInterval> | undefined,
  // Links queued from the command line are tracked as if pasted into Track
  // application links, a few at a time (each opens a tab). One for a site the
  // extension may not reach waits for the panel to ask for access.
  // One pick-up at a time; a request while one runs waits for it, so what it
  // tracked is in the state returned (the backend now asks for one as soon as a
  // link is queued, and the panel's own request had come back before it).
  pickingUp: undefined as Promise<void> | undefined,
  // When the side panel last said its report dialog is open (reload-gate.ts).
  reportBeat: 0,
  badgeTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  // Which applications the fixer has (the backend's repair records), asked for
  // at most every ten seconds: the badge warns of one the applicant should leave
  // alone.
  repairStates: {} as Record<string, string>,
  // What each repair puts the application under (section() in repairs.ts).
  repairSections: {} as Record<string, "needs fixing" | "being fixed" | undefined>,
  tabGroupTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  repairsAsked: 0,
  // Applications submitted before the history existed, or while the backend
  // was unreachable, are added to it once it answers.
  submissionsSynced: false,
  // Progress is written to storage a few times a second at most.
  progressTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  visiting: Promise.resolve(),
};
