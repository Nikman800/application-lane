// A command the service worker sends a frame (content/commands.ts): what the engine is, page timers, and reading the page.
// Split out of executeCommand as it was.
import { CONTENT_VERSION } from "../../../shared/model";
import { configEngineEnabled } from "../../../engine/mode";
import { Command, pause } from "../core";
import { cs } from "../state";
import { PAGE_TIMER_EVENT } from "../../../engine/page/timers";
import { inspect } from "../inspect";
import { documentId } from "../tracking";

  export async function handleEngineInfo(command: Command): Promise<unknown> {
  return { version: CONTENT_VERSION, documentId, configEngine: configEngineEnabled };
}

  // While a fill runs, a hidden page's own timers are run when due
  // (engine/page/timers.ts): this frame's clock, which Chrome does not slow,
  // calls them a few times a second.
  export async function handlePageTimers(command: Command): Promise<unknown> {
cs.pageTimersOn = Boolean(command.on);
if (cs.pageTimersOn && !cs.pumpingPageTimers) {
  cs.pumpingPageTimers = true;
  void (async () => {
    try {
      while (cs.pageTimersOn) {
        await pause(100);
        if (cs.pageTimersOn && document.visibilityState === "hidden")
          document.dispatchEvent(new Event(PAGE_TIMER_EVENT));
      }
    } finally {
      cs.pumpingPageTimers = false;
    }
  })();
}
return { on: cs.pageTimersOn };
}

  export async function handleInspect(command: Command): Promise<unknown> {
  return inspect();
}
