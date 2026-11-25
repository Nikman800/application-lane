// A command the service worker sends a frame (content/commands.ts): a step's own Next and Submit.
// Split out of executeCommand as it was.
import { inspect } from "../inspect";
import { stepControls, stepLabel, pressStep } from "../../../engine/page/step-controls";
import { adapterFor } from "../../adapters";
import { documentId } from "../tracking";
import { cs } from "../state";
import { INVISIBLE_CAPTCHA, Command } from "../core";
import { expectOwnedActivation } from "../controls";

  // Next and Submit are the applicant's own presses, made after they
  // looked over (and often edited) the page, which pauses its fill: they
  // check the page themselves rather than the fill's operation.
  // The step's own Next and Submit (step-controls.ts), for the applicant's
  // Next step and Submit in the panel or lane next / lane submit: what
  // this page would press, and what on it is still unfinished. Read only.
  export async function handleStepCheck(command: Command): Promise<unknown> {
const snapshot = inspect();
const controls = stepControls(document, adapterFor(location.href).next || undefined);
const label = (kind: "next" | "submit") => (controls[kind].length === 1 ? stepLabel(controls[kind][0]) : undefined);
return {
  documentId,
  // Bound to another application: never pressed for this one.
  foreign: Boolean(cs.applicationId && command.applicationId !== cs.applicationId),
  next: label("next"),
  nextCount: controls.next.length,
  submit: label("submit"),
  submitCount: controls.submit.length,
  // An invisible CAPTCHA runs when Submit is pressed: not a reason to hold it.
  blockers: [...snapshot.blockers.filter((blocker) => blocker !== INVISIBLE_CAPTCHA),
    ...(snapshot.pendingFields || []).map((label) => `${label}: still loading on the site.`)],
  unfinished: snapshot.fields
    .filter((f) => (f.required && !f.value) || f.invalid || f.validationWarning)
    .map((f) => (f.required && !f.value ? `${f.label}: empty` : `${f.label}: ${f.validationWarning || "not accepted"}`).slice(0, 160))
    .slice(0, 30),
};
}

  // Presses the one control STEP_CHECK named, on the same page, only if it
  // still says what the applicant confirmed and nothing on the step is
  // left unfinished.
  export async function handlePressStep(command: Command): Promise<unknown> {
if (cs.applicationId && command.applicationId !== cs.applicationId) throw new Error("This tab belongs to another application.");
if (command.documentId !== documentId) throw new Error("The page changed since it was checked. Check it again.");
const kind = command.step === "submit" ? "submit" : "next";
const snapshot = inspect();
const blocker = snapshot.blockers.find((entry) => entry !== INVISIBLE_CAPTCHA);
if (blocker) throw new Error(blocker);
if (snapshot.pendingFields?.length) throw new Error(`${snapshot.pendingFields[0]}: still loading on the site.`);
if (snapshot.fields.some((f) => (f.required && !f.value) || f.invalid || f.validationWarning))
  throw new Error("Some fields on this step are empty or not accepted. Finish them first.");
const controls = stepControls(document, adapterFor(location.href).next || undefined)[kind];
if (controls.length !== 1) throw new Error(`This page has ${controls.length || "no"} ${kind === "next" ? "Next" : "Submit"} button${controls.length === 1 ? "" : "s"} to press.`);
cs.writing = true;
try {
  expectOwnedActivation(controls[0], "click");
  pressStep(controls[0], kind, String(command.label || ""));
} finally {
  cs.writing = false;
}
return { pressed: stepLabel(controls[0]) };
}
