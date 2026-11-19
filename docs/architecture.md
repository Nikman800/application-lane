# Architecture and operation boundaries

## Components

The packaged React panel sends commands to the Manifest V3 worker. The worker tracks independent applications and sends revision-bound operations to isolated content scripts in each permitted frame only after an explicit **Fill this step** request. The worker is also the only extension component that calls the authenticated local backend. The Node service owns profile persistence, bounded generation jobs, AI requests, document rendering, and local issue reports.

The tracker is persisted in `chrome.storage.local`; backend state is written atomically to owner-only JSON files. Each application records its workflow stage, related posting/login/form tabs, one current fill target, and bounded fill-attempt history. Read-only page scans update tab context without starting work. Suggested tab associations require user confirmation. Events and short-lived scheduling drive explicitly requested fills. A Chrome alarm is a recovery trigger, not a promise of exact timing. On service worker restart, active applications pause and require another explicit fill request.

## Local HTTP interface

Every endpoint except the pairing handshake requires `Authorization: Bearer <pairing-token>`. JSON requests and responses are used throughout. The service accepts only a loopback Host and either the paired extension's origin or authenticated requests without an Origin header (local CLI use). The handshake (`POST /v1/hello`, `POST /v1/pair/request`) is the only unauthenticated part: it answers only a `chrome-extension://` origin, and hands out the token only for the six-digit code the backend printed, while it is unpaired or within ten minutes of `--pair` / `lane pair`; five wrong codes retire the code and lock pairing for a minute (src/server/pairing.ts). No unauthenticated status or artifact routes exist.

| Route | Purpose |
| --- | --- |
| **Pairing and status** | |
| `POST /v1/hello` | Unauthenticated, extension origin only: whether pairing is open. |
| `POST /v1/pair/request` | Unauthenticated, extension origin only: the code for the token. |
| `POST /v1/pair/open` | Command line only (no Origin): show a new pairing code. |
| `POST /v1/pair` | Bind the local service to the authenticated extension ID. |
| `GET /v1/status` | Non-secret provider configuration and generation limits. |
| `GET /v1/live` (WebSocket) | The command line's live line: commands to the extension and the queue as it changes. The token is its first message. |
| **Profile** | |
| `GET /v1/profile`, `PUT /v1/profile` | Versioned confirmed profile; stale updates are rejected. |
| `GET /v1/profile/application` | The profile as one application should state it (per-role graduation, preferences). |
| `GET /v1/profile/conflicts` | Where the profile and the tailoring folder's notes disagree. |
| `GET /v1/profile/bundle`, `PUT /v1/profile/bundle` | Export or import the profile (and tailoring files) to move it to another computer. |
| `POST /v1/import` | Base64 PDF/DOCX to unconfirmed plain text, limited to 10 MB. |
| **Settings** | |
| `PUT /v1/settings` | Generation concurrency (1–4) and checking. |
| `GET /v1/config`, `PUT /v1/config` | The Drafting settings: providers, checkers, endpoint, folders. The API key is write-only. |
| `PUT /v1/transcript` | Save the applicant's transcript (PDF or DOCX) for forms that ask for one. |
| **Drafting** | |
| `POST /v1/jobs` | Idempotent generation for an application ID and operation revision. |
| `GET /v1/jobs/:id`, `DELETE /v1/jobs/:id` | Poll a job or cancel pending work. |
| `POST /v1/jobs/:id/files`, `POST /v1/jobs/:id/files/open` | Write a job's documents to the documents folder, or open that folder. |
| `GET /v1/artifacts/:id` | Metadata and base64 bytes for a completed current-profile artifact. |
| **Applications** | |
| `GET /v1/queue`, `PUT /v1/queue` | The tracked applications as the command line sees them (mirrored by the extension). |
| `GET /v1/inbox`, `POST /v1/inbox`, `DELETE /v1/inbox` | Links queued from the command line or Find jobs, waiting for the extension. |
| `GET /v1/submissions`, `POST /v1/submissions`, `DELETE /v1/submissions/:id` | The history of submitted applications. |
| `GET /v1/search/settings`, `PUT /v1/search/settings`, `GET /v1/search`, `POST /v1/search` | Find jobs: its settings, the last results, and a new search. |
| **Reports and recordings** | |
| `POST /v1/issues`, `GET /v1/issues` | Persist a local diagnostic report or list report summaries. |
| `GET /v1/issues/:id`, `DELETE /v1/issues/:id` | Export or delete one full local diagnostic report. |
| `GET /v1/issues/:id/share` | A report cleaned of the applicant's details, for Share on GitHub. |
| `PUT /v1/issues/:id/network` | Attach a network capture to a saved report. |
| `POST /v1/recordings`, `GET /v1/recordings`, `GET /v1/recordings/:id`, `DELETE /v1/recordings/:id` | Page-activity recordings. |
| `POST /v1/captures` | A fill's capture, kept for replaying a problem. |
| `GET /v1/repairs`, `PUT /v1/repairs/:id`, `DELETE /v1/repairs/:id` | Repair records the command line's repair commands keep. |
| `GET /v1/fixer`, `GET /v1/fixer/settings`, `PUT /v1/fixer/settings`, `DELETE /v1/fixer/health` | Developer builds only: the maintainer's fixer. |
| **Your data** | |
| `DELETE /v1/data` | Cancel generation, then delete the profile, history, documents, reports, recordings and backups. |

Contracts and validation are in `src/shared/model.ts`. A generation request includes application ID, operation revision, profile revision, job text, and frame-prefixed field observations. An artifact is bound to an application and operation; its ID alone cannot authorize a page attachment.

## Write protection

- The content script observes trusted user activity in capture phase, marks itself paused synchronously, and notifies the worker to pause sibling frames and cancel generation.
- It records protected semantic field identities, current values, and monotonically increasing field revisions. The worker persists edit locks. Pre-populated values are protected on first inspection.
- Before every write, the script checks application, document, operation, field revision, expected value, connectivity, protection, composition, and focus. There is no `await` between the last check and assignment.
- A framework replacing a field with an incompatible value makes it protected. Ambiguous duplicate identities are never filled positionally. Human-cleared values remain protected when resumed.
- Only extension-owned, unedited attachments may be refreshed automatically. Pre-existing or manually changed files remain in place and are reported for review.
- Navigation, cancellation, profile changes, and resume invalidate generation identity. A returned result cannot make itself current or cause a click.

Synthetic events are sent through native value setters for reactive forms. Custom selection is limited to synchronous exact accessible options in background tabs. The user controls all Next and submit actions; signatures and consent boxes are theirs unless they allow them (below).

Every click a fill makes goes through one gate (`src/engine/page/click-gate.ts`): a site rule's action, the content script's own picks, and a real click sent through the debugger alike. It refuses any click that would press a submit control (a form's submit button, "Submit", "Send", "Apply now"), a step control (a short "Next", "Continue", "Save and Continue", "Review application"; a calendar's "Next month" is not one) or a signing control ("I agree", "Sign", "Certify"), on the element or any control it sits in. `mainWorld.ts` runs serialized in the page and keeps a copy of the same patterns; `tests/click-gate.test.ts` checks both.

Next and Submit are pressed only on the applicant's request (the panel's Next step and Submit, `lane next` and `lane submit`; `src/engine/page/step-controls.ts`), outside the gate. The content script answers `STEP_CHECK` with the one control of each kind that the frame shows, by exact wording, and what on the step is unfinished; the worker requires exactly one across the tab's frames. `PRESS_STEP` presses it only on the same document, while it still has that label (for Submit, the label the applicant confirmed), with no empty required field. Submit is off unless `settings.submitButton` is `on`.

Signing is the applicant's setting (Settings → Signatures, `Settings.signatures`, applied to each fill's profile by `withPermissions` in `src/shared/model.ts`; `src/engine/page/signatures.ts`): `never` (default), `self-id` (the name and date on a voluntary self-identification form, such as the disability form) or `all` (any signature, acknowledgment name or attestation). A typed signature box or signing date the setting does not cover is left and reported. Consent boxes ("I agree to the terms", privacy notices, certifications) are ticked only with `Profile.acknowledgeTerms`.

Fields that keep their own state and ignore both assigned values and synthetic events (Workday's date sections) are typed with real keystrokes through `chrome.debugger` (CDP `Input.dispatchKeyEvent`). The content script focuses the field and refuses if the tab has focus; the worker types only after the same token handshake that authorizes a MAIN-world write, and only the characters of the value plus exactly as many Backspaces as the field already holds, no modifiers and no file operations. Two exceptions pick from a list the way a person would: arrow keys and an Enter in the list's own box, and one mouse click on a listed option or a checkbox. An Enter is sent only to a combobox-like field or one outside any form, so it cannot submit the form; a click is sent only after the gate finds what lies at its point and refuses a submit, step or signing control there, checked again as the worker asks to send it. Because those keystrokes are indistinguishable from the user's, the pause rules exempt trusted key, input and change events on that one element for the duration of that burst, including the trusted change its closing blur fires. The exemption holds only while the tab is unfocused, where the user's own keys cannot reach the page. The debugger is attached per lane and detached when the lane settles, pauses, is cancelled, or its tab closes; if it cannot be attached, the field falls back to the assigned value.

On navigation, the worker invalidates the current fill identity, performs a read-only scan, and pauses the application. The new page may remain grouped with the application, but filling never resumes until the user explicitly requests it. This applies to same-origin steps and login/session handoffs alike.

## Diagnostic reports

Issue capture is user initiated and requires a checkbox acknowledging that ordinary entered values are included. The worker pauses only the affected application, takes a bounded snapshot of accessible frames, and stores the report as an owner-only JSON file under `.local/issues/`. Passwords, authentication/session tokens, one-time codes, CSRF controls, and file contents are redacted at capture time. Reports contain the extension/application state needed for debugging and remain until individually deleted or all local application data is deleted.

## Failure behavior

Unknown eligibility and demographic questions stay unanswered unless the profile contains an exact reusable answer. Passwords remain manual; signatures, certifications and consent boxes too, unless the applicant's settings allow them. The provider returns short per-request fact references, narrative-question references and the cover letter text, with a 2,400-token output cap. A truncated response is discarded rather than repaired. Only empty, unprotected, nonsensitive narrative questions are included (up to 20); resume and cover selections are capped at 24 and four facts. Saved fact and field identities are unchanged. The cover letter is the one place model prose reaches a document: each written paragraph is kept only with its claim check, which compares every number, acronym, product name and mid-sentence capitalised word against the confirmed facts, the applicant's own profile and the posting. Unmatched words become a review warning that names them; the draft is still delivered, because the applicant decides what to do with it. Resume bullets remain verbatim confirmed text. Written answers are model prose from the profile, held to the same checks as the letter: a sentence the checker faults is taken out, and an answer that loses too much is left for the applicant.

Responses are normalized to the internal narrative contract: selected references must resolve to confirmed facts, and text comes from that profile. Legacy entries missing a fact ID can be recovered only by exact confirmed text equality. Invalid entries are discarded; an empty cover selection uses resume evidence. Unusable responses, including truncated completions, use a stable keyword-ranked local draft with no generated narrative answers. Repaired and fallback drafts carry locally generated review warnings in `narrative.warnings`, and the panel displays them on the application and document preview. Provider-supplied warnings and prose are not trusted.

Generation follows the ordered `draftProviders` policy. Each CLI or HTTP entry has its own deadline, and the total request deadline is the sum of those bounded attempts. A failed or usage-limited entry moves sequentially to the next; providers are never raced in parallel. Short HTTP Retry-After delays are honored inside that provider's deadline. Exhausting the policy uses a warned local draft where the workload supports one. Cancellation never invokes another fallback; the queue also rechecks cancellation and profile revision before and after rendering. Separate Codex entries can use separate authentication homes. Backend restarts fail incomplete jobs rather than silently replaying them. Logs expose provider names, timings, attempt count, status, whitelisted finish reason, and recovery category only; they never log applicant bodies, provider text, credentials, or model output.

## Limits to the guarantees

Human input in one frame pauses that frame synchronously; notification to other renderer processes is asynchronous. Already-dispatched site actions and the site's own scripts cannot be recalled or controlled completely. A malicious or unusual website can react to normal input events in unexpected ways.

The first adapter set is validated against local representative fixtures, not every configuration of each ATS. Live provider quality, authenticated employer flows, CAPTCHA handling, remotely populated autocomplete controls, and employer upload acceptance require user review and further live verification. Throughput measurements with a fake generator demonstrate local scheduling behavior only.
