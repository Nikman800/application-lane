import type { MainWorldRequest, MainWorldResult } from "./mainWorld";
import { clickPointAllowed, enterAllowed } from "./click-gate";

export type MainWorldGuard = {
  applicationId: string;
  documentId: string;
  operation: number;
};

const marker = "data-application-lane-main";
const pending = new Map<
  string,
  { element: Element; guard: MainWorldGuard; valid: () => boolean }
>();

export function authorizeMainWorld(
  guard: MainWorldGuard,
  token: string,
): boolean {
  const entry = pending.get(token);
  return Boolean(
    entry &&
    entry.guard.applicationId === guard.applicationId &&
    entry.guard.documentId === guard.documentId &&
    entry.guard.operation === guard.operation &&
    entry.element.isConnected &&
    entry.element.getAttribute(marker) === token &&
    entry.valid(),
  );
}

// The elements the fill is acting on from outside this script right now,
// and since when: moving focus to one commits a value left typed in another
// (a trusted change there), which is the fill's doing, not the applicant's.
const acting = new Map<Element, number>();
export const actingSince = (): number | undefined =>
  acting.size ? Math.min(...acting.values()) : undefined;
export const actingOn = (path: EventTarget[]) => path.some((entry) => entry instanceof Element && acting.has(entry));

// Both the MAIN world and the debugger act on the page from outside this
// content script, so both claim the element through the same one-shot token:
// the background can only write where `authorizeMainWorld` still agrees.
async function claimed<T>(
  element: Element,
  guard: MainWorldGuard,
  signal: AbortSignal | undefined,
  valid: () => boolean,
  send: (token: string) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  if (!valid()) throw new Error("Field write is stale or locked.");
  const token = crypto.randomUUID();
  element.setAttribute(marker, token);
  pending.set(token, {
    element,
    guard,
    valid: () => !signal?.aborted && valid(),
  });
  const revoke = () => {
    pending.delete(token);
    if (element.getAttribute(marker) === token) element.removeAttribute(marker);
  };
  signal?.addEventListener("abort", revoke, { once: true });
  acting.set(element, performance.now());
  try {
    const result = await send(token);
    signal?.throwIfAborted();
    return result;
  } finally {
    acting.delete(element);
    signal?.removeEventListener("abort", revoke);
    revoke();
  }
}

export async function requestMainWorld(
  element: Element,
  guard: MainWorldGuard,
  request: Omit<MainWorldRequest, "token">,
  signal?: AbortSignal,
  valid: () => boolean = () => true,
): Promise<MainWorldResult> {
  return claimed(element, guard, signal, valid, async (token) => {
    const response = await chrome.runtime.sendMessage({
      type: "MAIN_WORLD_APPLY",
      ...guard,
      request: { ...request, token },
    });
    if (!response?.ok)
      throw new Error(response?.error || "MAIN-world write failed.");
    return response.data as MainWorldResult;
  });
}

// Real keystrokes for a widget that ignores synthetic events. The element must
// already be focused: CDP types into the focused node, so `valid` is what keeps
// the keys from landing anywhere else.
export async function requestTrustedType(
  element: Element,
  guard: MainWorldGuard,
  text: string,
  clear: number,
  signal?: AbortSignal,
  valid: () => boolean = () => true,
  enter = false,
  choose: boolean | number = false,
  hold = false,
  click?: { x: number; y: number },
  insert = false,
): Promise<MainWorldResult> {
  // A real click or Enter goes wherever the page has it land, so where it
  // lands is checked as the background asks to send it (authorizeMainWorld),
  // not only now: it must never press a submit, Next or signing control.
  const presses = enter || (choose !== false && choose !== 0 && !hold);
  if (presses && !enterAllowed(element)) throw new Error("Refused an Enter that could submit or move the form on.");
  if (click && !clickPointAllowed(click, element.ownerDocument))
    throw new Error("Refused a click that would land on a submit, Next or signing control.");
  const checked = () =>
    valid() &&
    (!presses || enterAllowed(element)) &&
    (!click || clickPointAllowed(click, element.ownerDocument));
  return claimed(element, guard, signal, checked, async (token) => {
    const response = await chrome.runtime.sendMessage({
      type: "TRUSTED_TYPE",
      ...guard,
      request: { clear, text, token, ...(enter ? { enter: true } : {}), ...(choose ? { choose } : {}), ...(hold ? { hold: true } : {}), ...(click ? { click } : {}), ...(insert ? { insert: true } : {}) },
    });
    if (!response?.ok)
      throw new Error(response?.error || "Trusted typing failed.");
    return (response.data as MainWorldResult) || { ok: true };
  });
}
