# Changelog

All notable changes to Application Lane are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

- Form filling uses your saved profile and job-type overrides. Profile now stores work arrangements, start dates, and full-time availability. Saved salary and clearance details answer matching fields, and `preferences.md` supplies context for written answers.
- School lists can match the full names and short names for IIT Bombay, IIT Delhi, and IIT Madras.
- An AI answer to a legal question that does not cite the saved legal detail the question is about (a saved clearance offered for a conviction question) is filled with a caution beside it in "Filled by AI: check these", not left empty.
- Claude Code gets its instructions from a file instead of the command line, so drafting works with an npm-installed `claude.cmd` on Windows.
- Settings → Processing calls the drafting limit **Applications drafted at once**, which is what it limits. The docs describe written answers as model-written and checked, and list every backend route.

- `state.json`, which holds your profile, now records its format. Before it is changed on load (an older format, or a profile that only loads in part) the file as it was is kept as `state.json.backup-<time>`; a file a newer version wrote, or one that cannot be read, stops the backend with a message naming it instead of being overwritten. Delete local application data removes the backups too.

- **Settings → Drafting → Checking** now says when nothing checks your drafts: with one Drafting provider and no checker, no second model can check them. A checker or provider added in Settings checks the next drafts without restarting the backend, as Settings promises.

- Security and privacy: Find jobs' site check and the posting reader open only public pages, by name and by every address the name resolves to, and check every redirect the same way, so a listing cannot have the backend open a page on your computer or your network. Written answers no longer send what you chose in sensitive fields (gender, disability, authorization and similar) to the drafting provider. PRIVACY.md now lists exactly what each kind of draft sends.

- Security and privacy: a tailored résumé's summary and skills are written as text only, so a posting cannot slip a LaTeX command (such as reading a local file) into the résumé, and pdflatex runs with shell escape off and file access limited to its build folder. Network capture for reports no longer keeps passwords, one-time codes, tokens or session keys from requests, addresses or JSON replies. **Delete local application data** now also removes report screenshots, the fixer's list of repairs, the imported tailoring folder and your leak-check terms.

- Maintainers: the isolated session that works on shared reports no longer holds the Claude token. The repository is fetched in one container; the agent works in a second one with no network, reaching Claude only through a proxy outside it that adds the token and passes on nothing but the Messages API. Run `sudo bash scripts/report-sandbox/setup.sh` again (Enter keeps the token), then the check.

- A drafted answer the checking model faulted is kept on the profile's word only when one entry of your profile names everything it names, as whole words, outside your Known gaps, and it adds no duration, frequency or seniority. Before, a name written anywhere in your notes was enough, so "No Redis" under Known gaps could vouch for "three years of Redis". Your confirmed facts are also no longer read as part of the last section of your profile.md.

- Eligibility answers are more careful. A list that words its answers as sentences ("Yes, I am a U.S. citizen") gets a plain Yes or No only when the sentence adds nothing the question does not ask. A work-authorization or sponsorship answer is given only for the job's country, and "Do you authorize a background check?" is no longer read as a work-authorization question. With AI filling automatic, questions about identity, work eligibility and pay are filled like any other and listed for you to check.

- Every click a fill makes now passes one check that refuses Submit, Next, Continue and signing controls, including real clicks and Enter presses sent through the debugger.
- **Next step** and **Submit…** on an application's card, and `lane next` / `lane submit`, press the page's own Next or Submit on request. Submit is off until **Settings → Processing** turns it on, shows the button, anything unfinished and the answers AI filled before it presses, and presses only after you confirm.
- **Your profile → Signatures** decides what a fill signs: nothing (the new default), self-identification forms, or every form. Before this, Lever's and Workday's self-identification signatures and Tesla's legal acknowledgment were filled without asking; turn the setting on to keep that.

## 0.1.0 — initial public release

### Filling applications

- Parallel application lanes: track many applications and fill several at once, with limits per site and on active fills (adjustable in Settings).
- Side panel listing every tracked application with its stage, related tabs, current fill target, fill history and saved issues; login and emailed-link tabs can be grouped with an application after you confirm.
- **Fill this step** fills the current step only. The extension never clicks Next, Continue or Submit, never signs or ticks consent boxes, and never submits.
- Edit locks: typing, clicking or picking in a form pauses that application's fill, and fields you edited or cleared are never overwritten. Every write is checked against the field's revision and expected value just before it happens.
- Site rules for Workday, Greenhouse, Lever, Ashby, iCIMS, SmartRecruiters, Workable, Oracle, Paylocity, JazzHR and Rippling (plus a few employer-specific sites), and general form matching for everything else.
- Queue links in bulk with **Track application links** or the command line.
- **Save answers I entered** keeps answers you gave by hand for the same question on future applications.
- Unfilled structured fields listed after each fill, with optional AI suggestions you approve first.
- AI filling modes: fill automatically, review first, or profile only. Legal and eligibility questions are answered only from details you wrote yourself.

### Profile

- Import résumés from PDF and DOCX, processed on your computer; facts are merged into a cumulative list and confirmed by you before use.
- Confirmed profile with contact details, work and education history, legal and eligibility details, and saved answers.
- Export and import a profile to move it to another computer (without tokens, keys or applications).

### Drafting

- Drafting providers: Claude Code CLI, Codex CLI, or any OpenAI-compatible API, in an ordered fallback list set in **Settings → Drafting**. With no provider, filling still works and drafting points you to Settings.
- Tailored résumé and cover letter as PDF and DOCX, plus drafted answers to written questions, all shown for review. Résumé bullets keep your confirmed wording; claims in drafted text that your profile does not support are flagged, and an optional second model checks them.
- Built-in ATS-friendly single-column résumé layout, with optional LaTeX tailoring of your own résumé sources (Python 3 and `pdflatex`).
- Full postings read from job boards' public endpoints (Greenhouse, Lever, Ashby, Workday, Oracle, Workable, SmartRecruiters) so drafts are tailored to the real posting.
- Documents also saved as files under `Documents/Application Lane`, one folder per job, with copy-path buttons for manual uploads.
- **Check fit** compares a posting with your background, requirement by requirement.

### Finding jobs and progress

- **Find jobs** searches SimplifyJobs' new-grad and internship lists and the Greenhouse, Lever and Ashby boards of companies you name, filtered by role, place, country, recency and seniority.
- Momentum card in the side panel and a progress board on the dashboard: daily streak, daily goal, levels, a 12-week heatmap and badges.
- Themes: System, Sage, Midnight, Ember, Aurora, Velocity and High contrast.

### Command line

- `lane add`, `status`, `failures`, `watch`, `fill`, `switch`, `search` and a full-screen `ui`, sharing the extension's themes (`--theme`, `LANE_THEME`, `NO_COLOR`).

### Setup and security

- Zero-config start: the first `npm start` (or `application-lane`) creates settings and prints a pairing code.
- One-click pairing from the dashboard with a 6-digit code, limited to extension origins, the unpaired state or a 10-minute window, and locked after five wrong codes.
- Dashboard onboarding checklist.
- Data kept in the per-user app-data folder; `LANE_DATA_DIR` overrides it.
- Backend bound to `127.0.0.1` with Host and Origin checks, a constant-time token check, and owner-only config permissions.
- Local issue reports and page-activity recordings for debugging; network capture is opt-in.
- Packaging: `npm run package` builds a release zip of the extension and an npm package of the backend (`application-lane` and `lane` commands); `npm run build -- --store` builds a Chrome Web Store variant without the `debugger` permission.
