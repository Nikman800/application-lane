// Fields that sign for the applicant, and whether their settings let a fill
// write them (Settings → Signatures; withPermissions in shared/model.ts).
//
// A typed name in a signature box is a legal signature, and its date says
// when it was signed. Two kinds are told apart:
// - "self-id": the name and date on a voluntary self-identification form
//   (the disability form, a veteran or EEO statement);
// - "attestation": any other signature, acknowledgment name or certification
//   of the whole application.
// The applicant chooses which, if any, a fill may sign; by default none.

import type { SignaturePolicy } from "../../shared/model";

export type SignatureKind = "self-id" | "attestation";

// "eeo[disabilitySignatureDate]" → "eeo disability Signature Date".
const words = (text: string) =>
  text.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[^A-Za-z0-9]+/g, " ").trim();

const signing = /\bsignature\b|\bsigned\b|\be ?sign(?:ed|ing|ature)?\b|\bsign (?:here|below|your name)\b|\btyped name\b|\backnowledg\w* name\b|\blegal acknowledg\w*/i;
const signingDate = /\b(?:signature|signing|signed) ?(?:on|date)\b|\bdate signed\b|\btodays? date\b|\bcurrent date\b/i;
const selfIdentification = /\b(?:disabilit\w*|veterans?|self ?identif\w*|eeo|voluntary)\b|\binvitation to self/i;
const nameField = /\bname\b/i;

// The words that identify a field: its name, id, accessible name, label,
// placeholder, and the field wrappers sites name it by (Workday's
// data-automation-id="formField-dateSignedOn").
function identity(element: Element): string {
  const parts: string[] = [];
  for (const attribute of ["name", "id", "aria-label", "placeholder"]) {
    const value = element.getAttribute(attribute);
    if (value) parts.push(value);
  }
  for (const label of (element as HTMLInputElement).labels || []) parts.push(label.textContent || "");
  let node: Element | null = element;
  for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
    const wrapper = node.getAttribute("data-automation-id") || node.getAttribute("data-fkit-id");
    if (wrapper) parts.push(wrapper);
  }
  return words(parts.join(" "));
}

// The small group a field sits in (its own question, or the name and date of
// one signature block), never the whole application form: that names every
// section, and would make any field look like part of the disability form.
function group(element: Element): Element | undefined {
  let found: Element | undefined;
  let node = element.parentElement;
  for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
    if (node.matches("form,body,main")) break;
    if (node.querySelectorAll("input,select,textarea").length > 6) break;
    found = node;
  }
  return found;
}

function hasSigningDate(container: Element, except: Element): boolean {
  for (const field of container.querySelectorAll("input,[data-automation-id]")) {
    if (field === except || field.contains(except)) continue;
    if (signingDate.test(words([field.getAttribute("data-automation-id"), field.getAttribute("name"), field.getAttribute("id")].filter(Boolean).join(" "))))
      return true;
  }
  return false;
}

// The kind of signature this field holds, or undefined for an ordinary field.
export function signatureField(element: Element): SignatureKind | undefined {
  // A signature is typed: a box or a date. A Yes/No about something signed
  // ("Have you signed a non-compete?") or a consent box is not one (consent
  // boxes are Settings → Terms and consent boxes).
  if (element.tagName.toLowerCase() !== "input") return undefined;
  if (/^(checkbox|radio|file|hidden|button|submit|image|reset|password|range|color)$/i.test((element as HTMLInputElement).type)) return undefined;
  const own = identity(element);
  const container = group(element);
  const near = words(container?.textContent?.slice(0, 2000) || "");
  let signs = signing.test(own) || signingDate.test(own);
  // A plain "Name" that belongs to a self-identification form
  // ("selfIdentifiedDisabilityData--name", "eeo.eeoDisabilityStatusName"), or
  // sits beside a signing date (Workday's disability page), is its signature.
  if (!signs && nameField.test(own))
    signs = selfIdentification.test(own) || Boolean(container && hasSigningDate(container, element));
  if (!signs) return undefined;
  return selfIdentification.test(own) || selfIdentification.test(near) ? "self-id" : "attestation";
}

export function signingAllowed(policy: SignaturePolicy | undefined, kind: SignatureKind): boolean {
  if (policy === "all") return true;
  return policy === "self-id" && kind === "self-id";
}

export function signatureLeftReason(kind: SignatureKind): string {
  return kind === "self-id"
    ? "Signing a self-identification form is left for you (Settings → Signatures)."
    : "Signatures and attestations are left for you (Settings → Signatures).";
}
