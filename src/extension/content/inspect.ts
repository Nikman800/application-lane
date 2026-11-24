// Part of the content script (content.ts): reading the page's form into an observation.
// Split out of content.ts as it was; see content.ts for how it starts.
import { type Observation, type Field, normalize } from "../../shared/model";
import { adapterFor } from "../adapters";
import { writable, controlVisible, isToggleChoice, sectionFor, placeholderOption, isRequired, fieldWordLimit, replacesForm, groupQuestion, checkboxEntryTitle, hiddenAnswerQuestion, validationState, rendered, wfnDropdown } from "../semantics";
import { radioGroup, lockKey, closestAcrossShadows, searchWithoutPick, manualSigningControl, clip, drawnOptions, picksOf, inEntryEditor, readableText, nextButton } from "../content-dom";
import { configEngineEnabled } from "../../engine/mode";
import { resumeSlotOpen, slowResumeParse, configUploadSlots, addableCollections } from "../../engine/runtime";
import { cs } from "./state";
import { adoptSiteValue, besideLastWrite, controls, hasEditLock, lockReason, valueOf, writePending } from "./controls";
import { INVISIBLE_CAPTCHA, calendarBox, dateFormatHint, legacyReactSelect, pickerBox } from "./core";
import { addLock, documentId, fieldLabel, fileKind, nodeRecords, ownLabel, records, semanticIds } from "./tracking";

export function inspect(): Observation {
  const ats = adapterFor(location.href);
  const fields: Field[] = [];
  const counts = new Map<string, number>();
  const positionedRadioGroups = new Set<string>();
  for (const element of controls()) {
    // A read-only box filled from its own picker (Tesla's start date) is a
    // question all the same: listed, so an empty one is said to need you
    //. Only a picker writes it.
    if (!writable(element) && !(pickerBox(element) && controlVisible(element))) continue;
    // A read-only combobox naming its list is a list, picker button or not:
    // Microsoft's careers form read its sponsorship and location lists as
    // date pickers, and their options were never read.
    const listBox = element.getAttribute("role") === "combobox" && Boolean(element.getAttribute("aria-controls")) && !calendarBox(element);
    const kind =
      pickerBox(element) && !listBox
        ? "datepicker"
        : cs.fileControls.has(element)
        ? "file"
        : isToggleChoice(element)
        ? "radio"
        : element.matches(`button[aria-haspopup="listbox"],button.fab-SelectToggle[data-menu-id],${legacyReactSelect}`) || element.closest(".pcty-input-select__input") || wfnDropdown(element)
        ? "combobox"
        // A text box that opens a calendar (react-datepicker; Ashby's
        // "ashby-application-form-input-date") takes only a date: on
        // leaving it, the picker drops anything else ("Immediately").
        // (SuccessFactors' UI5 date picker's input calls itself a "Date
        // Input": "What year…will you receive your degree?" there takes a
        // date.)
        // Amazon's is a combobox opening a calendar dialog, "YYYY-MM-DD":
        // as a list, it was opened and waited on for options it never has.
        : element instanceof HTMLInputElement && element.type === "text" &&
            (element.closest(".react-datepicker__input-container") || /(^|[\s_-])input-date\b/.test(element.className) ||
              element.getAttribute("aria-roledescription") === "Date Input" ||
              calendarBox(element))
        ? "datepicker"
        // A native list is one whatever role it is given: one employer's iCIMS
        // screening questions are <select role="combobox"> naming a
        // listbox that never appears, and were waited on as custom lists
        // until "Dropdown options were not available".
        : element instanceof HTMLSelectElement
        ? "select"
        : element.getAttribute("role")
        ? element.getAttribute("role")!
        // A type the browser does not know reads as "text": SuccessFactors'
        // "currency" box takes a number only ("Invalid number." for
        // "$100,000 per year.", an employer).
        : element instanceof HTMLInputElement && /^(currency|decimal|integer)$/i.test(element.getAttribute("type") || "")
          ? "number"
        : element instanceof HTMLInputElement
          ? element.type
          : element instanceof HTMLTextAreaElement
            ? "textarea"
            : element instanceof HTMLSelectElement
              ? "select"
              : "combobox";
    const label = fieldLabel(element);
    const group = kind === "radio" ? radioGroup(element) : [element];
    const representative = group.find(writable) || element;
    if (representative !== element) {
      const record = nodeRecords.get(representative as HTMLElement);
      if (record) nodeRecords.set(element, record);
      continue;
    }
    const section = sectionFor(element);
    const base = `${lockKey({ label, ...section })}:${kind}`;
    const occurrence = counts.get(base) || 0;
    counts.set(base, occurrence + 1);
    const semanticKey = `${base}:${occurrence}`;
    let record = nodeRecords.get(element);
    let id = semanticIds.get(semanticKey);
    if (!id) {
      id = record?.id || crypto.randomUUID();
      semanticIds.set(semanticKey, id);
    }
    const current = valueOf(element);
    if (!record) {
      const previous = records.get(id);
      record = {
        element,
        id,
        last: current,
        revision: (previous?.revision || 0) + 1,
        protected:
          (Boolean(current) && !previous?.automationWritten) ||
          Boolean(previous?.protected) ||
          hasEditLock(element, label),
        protectedBy: hasEditLock(element, label)
          ? lockReason(element, label)
          : previous?.protected
            ? previous.protectedBy
            : current && !previous?.automationWritten
              ? "existing value"
              : undefined,
        label,
        automationWritten: previous?.automationWritten,
        writePendingAt: previous?.writePendingAt,
        conflict: previous?.conflict,
      };
      // A replacement node is never trusted based solely on positional matching.
      // A site rebuilding the form empty where we had written a value
      // (Workday after "discard changes") rejected our value, as when it
      // clears a field in place: the next fill may try again.
      const clearedOurs =
        previous?.automationWritten && !previous.protected && !current && !hasEditLock(element, label);
      if (clearedOurs) {
        record.automationWritten = false;
        record.fillWarning = "The site cleared the value that was filled.";
      } else if (
        // Ours or not as recorded: a value no one typed (typing leaves an
        // edit lock) that the site wrote over when it redrew the form is
        // its own. SuccessFactors' resume parser put "UNSPECIFIED" over
        // the profile's company, its own title and the 1st and the 30th for dates, and
        // they were kept as the applicant's (Fabrikam).
        previous &&
        previous.last &&
        previous.element !== element &&
        previous.last !== current &&
        !writePending(previous) &&
        !hasEditLock(element, label)
      ) {
        // A site that rebuilds its form puts its own values where ours
        // were: SuccessFactors, saving an uploaded resume, wrote back what
        // it parsed from it ("UNSPECIFIED" for a company, the 1st and the
        // 30th for dates) and those were then kept as if the applicant had
        // chosen them. No one typed
        // there: it is the site's value, and the next fill corrects it.
        record.protected = false;
        record.protectedBy = undefined;
        record.automationWritten = false;
        record.siteValue = true;
        record.confirmed = false;
        record.fillWarning = "The site replaced the value that was filled.";
      } else if (
        previous &&
        previous.element !== element &&
        previous.last !== current &&
        !writePending(previous)
      ) {
        record.protected = true;
        record.protectedBy = `replaced element changed value (${JSON.stringify(previous.last.slice(0, 40))} to ${JSON.stringify(current.slice(0, 40))})`;
      }
      if (
        !clearedOurs &&
        writePending(previous) &&
        previous?.automationWritten &&
        previous.last !== current
      )
        record.conflict = true;
      adoptSiteValue(record);
      nodeRecords.set(element, record);
      records.set(id, record);
    }
    for (const member of group) nodeRecords.set(member, record);
    if (record.label !== label) {
      if (!writePending(record)) {
        record.protected = true;
        record.protectedBy = `label changed from ${JSON.stringify(record.label.slice(0, 60))}`;
        addLock(lockKey({ label, ...section }), `${label}: ${record.protectedBy}`);
      }
      record.revision++;
      record.label = label;
    }
    if (record.last !== current) {
      record.siteValue = false;
      const was = record.last;
      // The site reformatting a value we wrote ("6025550101" shown as
      // "(602) 555-0101") is still our value, whenever it happens.
      const reformatted =
        record.automationWritten &&
        Boolean(current) &&
        was.toLowerCase().replace(/[^a-z0-9]/g, "") ===
          current.toLowerCase().replace(/[^a-z0-9]/g, "");
      // The site clearing a value we wrote rejected it; that is not the
      // applicant's decision, so the next fill may try again.
      const rejected = record.automationWritten && !current;
      const engineRelated = writePending(record) || reformatted;
      record.revision++;
      record.last = current;
      record.attachmentId = undefined;
      record.conflict = engineRelated || rejected ? false : record.automationWritten;
      record.automationWritten = engineRelated;
      record.writePendingAt = undefined;
      if (rejected && !engineRelated)
        record.fillWarning = "The site cleared the value that was filled.";
      else if (!engineRelated && !cs.paused && performance.now() < cs.siteFillUntil) {
        // The site is filling the form from the resume this extension
        // just uploaded, and nobody has touched the page: what it writes
        // is the site's guess, to be corrected from the profile, not an
        // edit of the applicant's to lock.
        record.siteValue = true;
        record.confirmed = false;
      }
      else if (!engineRelated && !cs.paused &&
        ((cs.applicationId && closestAcrossShadows(element, ".RCMFormField")) ||
          element.closest('[data-automation-id="applicationPage"] [data-automation-id^="formField-"]')) &&
        performance.now() - cs.lastApplicantInput > 2000) {
        // Workday's Autofill with Resume does the same, as its page loads
        // and before any fill: its parser set Phone Device Type to
        // Landline after the page was read, and the profile's Mobile was
        // never written.
        // SuccessFactors puts back an answer it stored ("No" to clearance
        // eligibility) whenever another field of its form changes, and that
        // was locked as the applicant's. Nobody touched the page, and an applicant's change
        // comes with their own click or keys: it is the site's value, for
        // the profile to correct. (Elsewhere a change nobody can account for
        // is kept, as it may be the applicant's own tool's.)
        record.siteValue = true;
        record.confirmed = false;
      }
      else if (!engineRelated && !cs.paused && cs.applicationId && besideLastWrite(element) &&
        performance.now() - cs.lastEngineWrite < 1500 && performance.now() - cs.lastApplicantInput > 2000) {
        // The site answering a write of ours in the same small group of
        // fields: Ashby puts this year in a date's empty Year once its Month is
        // picked. Locked as the applicant's, the saved year was never
        // written, and the end date, kept after the start, followed it.
        record.siteValue = true;
        record.confirmed = false;
      }
      else if (!engineRelated) {
        record.protected = true;
        record.protectedBy = `value changed outside a fill (${JSON.stringify(was.slice(0, 40))} to ${JSON.stringify(current.slice(0, 40))})`;
        addLock(lockKey({ label, ...section }), `${label}: ${record.protectedBy}`);
      }
    }
    // An empty field has no value left to guard: only the applicant's own
    // clearing or lock keeps it empty, never what the site did to it
    // (rebuilt it, cleared it, relabelled it).
    if (
      record.protected &&
      !current &&
      (!/^a real/.test(record.protectedBy || "") || searchWithoutPick(element)) &&
      !hasEditLock(element, label)
    ) {
      record.protected = false;
      record.protectedBy = undefined;
    }
    // A signature can be labelled only "First & Last Name". Explicit
    // control identities still keep signatures and initials manual,
    // including configured fills and reviewed fallback writes.
    if (manualSigningControl(element)) {
      record.protected = true;
      record.protectedBy = "manual signature or initials";
    }
    const options =
      element instanceof HTMLSelectElement
        ? [...element.options]
            .filter((o) => !o.disabled && !placeholderOption(o))
            .map((o) => clip(o.label))
        : kind === "checkbox"
          ? ["Yes", "No"]
          : kind === "radio"
            ? group.filter(writable).map((candidate) => ownLabel(candidate))
            : kind === "combobox"
              ? drawnOptions(element)
              : [];
    // Every text is clipped to the backend's limits: one over-long lock
    // reason would otherwise reject the whole generation request.
    fields.push({
      id: record.id,
      label: label.slice(0, 1000),
      kind,
      value: (current || picksOf(element)).slice(0, 10000),
      required: cs.fileControls.get(element)?.required ?? cs.radioControls.get(element)?.required ?? isRequired(element),
      revision: record.revision,
      // An entry editor SmartRecruiters has open is its site rule's to
      // fill (the rule still writes there): its fields name no school or
      // job, and the general fill wrote one school's major and degree into
      // another's.
      protected:
        record.protected ||
        /password/.test(kind) ||
        label === "Unlabelled field" ||
        inEntryEditor(element),
      options: options.slice(0, 300),
      ...(options.length > 300 ? { optionCount: options.length } : {}),
      accept: (element.getAttribute("accept") || "").slice(0, 1000),
      format: dateFormatHint(element),
      maxWords: fieldWordLimit(element, label),
      ...((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
      element.maxLength > 0
        ? { maxLength: element.maxLength }
        : {}),
      documentKind: fileKind(element),
      replacesForm: replacesForm(element) || undefined,
      question: (kind === "checkbox" && (groupQuestion(element)?.text || checkboxEntryTitle(element) || hiddenAnswerQuestion(element))) || undefined,
      attachmentId: record.attachmentId,
      conflict: record.conflict,
      fillWarning: record.fillWarning?.slice(0, 350),
      protectedReason: record.protected ? (record.protectedBy || "unknown").slice(0, 300) : inEntryEditor(element) ? "a job or school entry its site rule fills" : undefined,
      siteValue:
        record.siteValue && !record.automationWritten && !record.confirmed && current ? true : undefined,
      valueText: element instanceof HTMLSelectElement && element.selectedOptions[0] &&
        element.selectedOptions[0].text.trim() !== current
        ? element.selectedOptions[0].text.trim().slice(0, 300)
        : undefined,
      ...validationState(element, current),
      ...section,
      section: section.section.slice(0, 500),
    });
    // Separate multi-option groups may repeat the same question (Lever).
    // Their occurrence IDs distinguish their positions; APPLY still checks
    // the exact node, revision, value and applicant edit locks.
    if (kind === "radio" && group.filter(writable).length > 1)
      positionedRadioGroups.add(record.id);
  }
  // A repeated text/upload control still has an ambiguous purpose. Radio
  // groups with their own options remain independently answerable.
  // The same list asked twice with the same choices is one question, both
  // answered alike: one employer's form repeats "Are you currently or have you
  // ever been employed by an employer…", and both were held back.
  const sameList = (field: Field) => {
    if (!/select|combobox/.test(field.kind) || !field.options.length) return false;
    const twins = fields.filter((other) => `${lockKey(other)}:${other.kind}` === `${lockKey(field)}:${field.kind}`);
    return twins.every((other) => other.options.join("\n") === field.options.join("\n"));
  };
  // A Yes box and a No box under each of two questions ("Are you a U.S.
  // Citizen?" then "Do you require sponsorship?", one employer's JazzHR
  // form) repeat the labels Yes and No, but their questions tell them apart.
  const twinKey = (field: Field) =>
    `${lockKey(field)}:${field.kind}${field.kind === "checkbox" && field.question ? `:${normalize(field.question)}` : ""}`;
  const twins = new Map<string, number>();
  for (const field of fields) twins.set(twinKey(field), (twins.get(twinKey(field)) || 0) + 1);
  // The applicant's name and today's date are one answer wherever they are
  // asked: Jobvite's self-identification step signs its veteran and its
  // disability form each with "Your Name" and "Today's Date", and both were
  // held back.
  const sameAnswer = (field: Field) =>
    /^(text|date)$/.test(field.kind) &&
    /^(your )?(full |legal )?name$|^(today s date|todays date|current date|date)$/.test(normalize(field.label));
  for (const field of fields)
    if ((twins.get(twinKey(field)) || 0) > 1 && !positionedRadioGroups.has(field.id) && !sameList(field) && !sameAnswer(field)) {
      field.protected = true;
      field.protectedReason ||= "another field has the same label";
    }
  // A page without a main region whose root is only its form (one employer's
  // careers page) keeps the posting outside that form: the
  // whole page is read, or the answers and documents never see the job.
  const matchedRoot = document.querySelector(ats.root);
  const pageRoot = !matchedRoot || matchedRoot.matches("form") ? document.body : matchedRoot;
  // A description the page keeps apart from its steps comes first: it is
  // what documents and answers are written from.
  const postingBlock = ats.posting ? document.querySelector(ats.posting) : null;
  const postingHTML = ats.postingHTML?.(document);
  const postingText =
    postingBlock && !pageRoot?.contains(postingBlock)
      ? clip(readableText(postingBlock), 20000)
      : postingHTML
        ? clip(readableText(new DOMParser().parseFromString(postingHTML, "text/html").body), 20000)
        : "";
  const pageText = clip(
    `${postingText ? `${postingText}\n` : ""}${readableText(pageRoot)}`,
    25000,
  );
  // "Sound Decisions - Herriman, UT": the employer, then where.
  const company = ats.company
    ? clip(document.querySelector(ats.company)?.textContent || "", 300).split(/\s[-–—|·]\s/)[0].trim()
    : "";
  const blockers: string[] = [];
  if ([...document.querySelectorAll('input[type="password"]')].some(rendered))
    blockers.push("Sign in or create your account manually.");
  if (
    document.querySelector(
      '[data-upload-status="pending"], [data-upload-status="error"], [data-automation-id="file-upload-error"]',
    )
  )
    blockers.push(
      "Wait for the document upload to finish or resolve the upload error.",
    );
  // An invisible CAPTCHA has nothing to click and never renders, so it was
  // silently missed here: the application read as prepared and the site then
  // refused the submission with its own verification error.
  const captchas = [
    ...document.querySelectorAll(
      'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [data-sitekey], script[src*="recaptcha/api.js"], script[src*="hcaptcha.com/1/api.js"]',
    ),
  ];
  const solved = [
    ...document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>(
      '[name="g-recaptcha-response"],[name="h-captcha-response"]',
    ),
  ].some((e) => e.value.trim());
  // Greenhouse's reCAPTCHA Enterprise shows only its corner badge
  // (size=invisible): rendered, yet nothing to solve before Submit, which
  // runs it. Read as one to complete, it held the applicant's Submit.
  const shown = (e: Element) =>
    rendered(e) && !/[?&]size=invisible(&|$)/.test(e.getAttribute("src") || "") && !e.closest(".grecaptcha-badge");
  if (captchas.length && !solved)
    blockers.push(captchas.some(shown) ? "Complete the site’s CAPTCHA if requested." : INVISIBLE_CAPTCHA);
  const next = nextButton();
  const atReview = [
    ...document.querySelectorAll('button, input[type="submit"]'),
  ].some(
    (b) =>
      b.getClientRects().length &&
      /^(submit( application)?|send application|complete application)$/i.test(
        clip(b.textContent || b.getAttribute("value") || ""),
      ),
  );
  for (const field of fields) cs.seenFields.add(field.id);
  return {
    documentId,
    url: location.href,
    // Not a heading the page keeps hidden until it is done (Breezy's
    // "Application Submitted").
    title: clip(
      [...document.querySelectorAll("h1")].find(rendered)?.textContent || document.title,
      1000,
    ),
    description: pageText,
    ...(company ? { company } : {}),
    ats: ats.name,
    fields,
    paused: cs.paused,
    ...(cs.paused && cs.pausedBy ? { pausedBy: cs.pausedBy } : {}),
    blockers,
    // SuccessFactors' Resume and Cover Letter are attachment widgets with
    // no file box: named here so a letter is drafted for its slot (an employer
    // drafted none).
    ...((slots) => (slots.length ? { documentSlots: slots } : {}))([...new Set([...document.querySelectorAll(".attachmentField label")]
      .map((label) => /cover\s*letter/i.test(label.textContent || "") ? "cover" : /\b(resume|cv)\b/i.test(label.textContent || "") ? "resume" : "")
      .filter(Boolean))]),
    ...(configEngineEnabled && resumeSlotOpen() ? { resumeSlotOpen: true } : {}),
    ...(configEngineEnabled && slowResumeParse() ? { slowResumeParse: true } : {}),
    uploadRequests: performance.getEntriesByType("resource").filter((entry) =>
      /^(xmlhttprequest|fetch)$/.test((entry as PerformanceResourceTiming).initiatorType) && /upload|parse/i.test(entry.name.split("?")[0])).length,
    ...((slots) => (slots.length ? { uploadSlots: slots } : {}))(configEngineEnabled ? configUploadSlots() : []),
    ...((folded) => (folded ? { foldedSections: folded } : {}))(document.querySelectorAll('.rcmFormSection button.rcmFormSectionTopBar[aria-expanded="false"]').length),
    canAdvance: Boolean(next),
    atReview,
    addable: fields.length || !configEngineEnabled ? undefined : addableCollections(),
    ...(/^https:/.test(document.referrer) && document.referrer !== location.href ? { referrer: document.referrer.slice(0, 3000) } : {}),
  };
}
