// The panel's queue page (panel.tsx, App): its markup, moved as it was.
import { type Recording, type QueueState, type WorkflowStage } from "../../shared/model";
import { FillLane } from "../fill-lane";
import { FieldFallback } from "../field-fallback";
import { JobFitAssessment } from "../job-fit";
import { QuestionAnswers } from "../question-answers";
import { DRAFT_ONLY_NOTE, draftOnlySite } from "../../shared/matching";
import { ConnectCard, OnboardingChecklist } from "../onboarding";
import { Momentum } from "../momentum";
import { StepButtons } from "../step-buttons";
import { uncheckedText } from "../../shared/model";
import { AppIssues, DraftingLink, FillProgress, Icon, PostingPrompt, TailoringBars, active, command, finished, hostname, labels, matchesQuery, openDashboard, postingMissing, postingSource, suggesting, type PanelState } from "../panel";

export function QueuePage({ panel }: { panel: PanelState }) {
  const { abandon, access, action, add, attachChoice, attention, busy, checkFit, clock, checked, connected, documents, fillPrerequisite, filter, linkedApplication, linkedFilling, listed, loadBackend, markSubmitted, onboardingSteps, pickerQuery, profile, progress, progressing, queue, ready, recordingHere, refreshRecordings, saveBlob, savePosting, scanActive, scanError, search, selected, setActiveRecordings, setAnswerSuggestions, setAttachChoice, setClock, setFilter, setIssueTarget, setNotice, setPage, setPickerQuery, setQueue, setRecordings, setSearch, setSelected, setShowArchived, setShowTabs, setTabs, setURLs, showArchived, showTabs, siteAccess, submissions, submittedCount, switching, tabContext, tabs, uploadFiles, urls } = panel;
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">APPLICATION WORKSPACE</div>
          <h1>Applications</h1>
        </div>
        <button className="icon-button" title="Scan current tab" aria-label="Scan current tab" onClick={() => void scanActive()}>
          <Icon type="check" />
        </button>
      </div>
      {!tabContext && switching && !scanError && (
        <section className="current-tab" aria-label="Current browser tab">
          <div className="section-title">
            <div>
              <span className="kicker">CURRENT TAB</span>
              <h2>{switching.title}</h2>
              <small>{switching.url ? hostname(switching.url) : ""}</small>
            </div>
            <span className="detect-badge">Reading…</span>
          </div>
          <p className="help">Reading this tab…</p>
        </section>
      )}
      {!tabContext && scanError && (
        <section className="current-tab" aria-label="Current browser tab">
          <span className="kicker">CURRENT TAB</span>
          <p className="fill-blocker">
            Couldn’t read this tab: {scanError}
          </p>
          <div className="context-actions">
            <button className="primary" disabled={busy} onClick={() => void action(scanActive)}>
              Scan again
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
                  if (!tab?.id) throw new Error("Open a job or application tab first.");
                  await siteAccess(tab.url);
                  setQueue(await command({ type: "TRACK_TAB", tabId: tab.id }));
                  await scanActive();
                })
              }
            >
              Track as new
            </button>
          </div>
        </section>
      )}
      {tabContext && (
        <section className="current-tab" aria-label="Current browser tab">
          <div className="section-title">
            <div>
              <span className="kicker">CURRENT TAB</span>
              <h2>{tabContext.title}</h2>
              <small>{tabContext.url ? hostname(tabContext.url) : ""}</small>
            </div>
            <span className={`detect-badge ${(tabContext.fieldCount ?? tabContext.observation?.fields.length) ? "found" : ""}`}>
              {tabContext.observation
                ? (tabContext.fieldCount ?? tabContext.observation.fields.length)
                  ? `${tabContext.fieldCount ?? tabContext.observation.fields.length} fields`
                  : "No form"
                : "Not scanned"}
            </span>
          </div>
          {tabContext.accessible && (
            <div className="recording-row">
              {recordingHere ? (
                <>
                  <span className="recording-dot" aria-hidden="true" />
                  <span>
                    Recording · {recordingHere.eventCount} events ·{" "}
                    {Math.floor((clock - recordingHere.startedAt) / 60000)}:
                    {String(Math.floor(((clock - recordingHere.startedAt) / 1000) % 60)).padStart(2, "0")}
                  </span>
                  <button
                    className="secondary small"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        const result = await command<{ recording: Recording; saved: boolean; saveError: string }>({
                          type: "STOP_RECORDING",
                          tabId: tabContext.tabId,
                        });
                        if (result.saved)
                          setRecordings((current) => [{ ...result.recording, events: undefined }, ...current]);
                        else
                          saveBlob(
                            `application-lane-recording-${result.recording.id}.json`,
                            JSON.stringify(result.recording, null, 2),
                            "application/json",
                          );
                        await refreshRecordings();
                        setNotice(
                          result.saved
                            ? `Recording saved with ${result.recording.eventCount} events. Find it under Issues.`
                            : `Backend unavailable; recording downloaded instead. ${result.saveError}`,
                        );
                      })
                    }
                  >
                    Stop recording
                  </button>
                </>
              ) : (
                <>
                <button
                  className="text-button"
                  disabled={busy || !connected}
                  title="Save answers you typed or picked on this page, to fill the same questions next time"
                  onClick={() =>
                    void action(async () => {
                      const found = await command<{ question: string; answer: string; replaces?: string }[]>({
                        type: "SUGGEST_ANSWERS",
                        tabId: tabContext.tabId,
                      });
                      if (!found.length)
                        throw new Error(
                          "No new answers to save here. Answer a question on the page yourself, then try again.",
                        );
                      setAnswerSuggestions(found.map((item) => ({ ...item, keep: true })));
                    })
                  }
                >
                  Save answers I entered
                </button>
                <button
                  className="text-button"
                  disabled={busy}
                  title="Record what happens on this page, for example while another autofill tool fills it"
                  onClick={() =>
                    void action(async () => {
                      setActiveRecordings(
                        await command({ type: "START_RECORDING", tabId: tabContext.tabId }),
                      );
                      setClock(Date.now());
                    })
                  }
                >
                  Record page activity
                </button>
                </>
              )}
            </div>
          )}
          {!tabContext.accessible && tabContext.permissionOrigin ? (
            <button
              className="primary"
              onClick={() =>
                void action(async () => {
                  if (!(await chrome.permissions.request({ origins: [tabContext.permissionOrigin!] })))
                    throw new Error("Site access was not granted.");
                  await scanActive();
                })
              }
            >
              Grant access to scan
            </button>
          ) : tabContext.applicationId ? (
            <>
            <p className="linked-application">
              Part of{" "}
              <strong>
                {(() => {
                  const linked = queue.applications.find((app) => app.id === tabContext.applicationId);
                  return linked ? `${linked.company} — ${linked.title}` : "a tracked application";
                })()}
              </strong>
              {queue.applications.find((app) => app.id === tabContext.applicationId)?.tabId !== tabContext.tabId &&
                " · Filling here makes this the current fill tab."}
            </p>
            {tabContext.frameOrigins?.length ? (
              <p className="app-posting">
                The form is in an embedded frame from{" "}
                {tabContext.frameOrigins.map((origin) => origin.replace(/^[a-z]+:\/\/(\*\.)?|\/\*$/gu, "")).join(", ")}.
                Fill this step asks Chrome for access to it first.
              </p>
            ) : null}
            {linkedApplication && (
              <div className="current-status">
                {/* A finished application shows its stage, not its last fill's
                    status: an abandoned one read "Needs attention", and
                    with no Abandon button the card looked broken. */}
                <span className={`status ${finished(linkedApplication) ? linkedApplication.workflowStage : suggesting(linkedApplication) ? "filling" : linkedApplication.status}`}>
                  {finished(linkedApplication)
                    ? ({ submitted: "Submitted", blocked: "Blocked", abandoned: "Abandoned" } as Record<string, string>)[linkedApplication.workflowStage]
                    : suggesting(linkedApplication) ? "Still filling" : labels[linkedApplication.status]}
                </span>
                <small>
                  {linkedApplication.filled} field{linkedApplication.filled === 1 ? "" : "s"} filled
                </small>
                {(active.includes(linkedApplication.status) || suggesting(linkedApplication)) && <FillLane />}
                <FillProgress app={linkedApplication} />
                <TailoringBars app={linkedApplication} />
                {suggesting(linkedApplication) && (
                  <p className="app-note">AI is suggesting values for the fields left open. You can carry on in the form: your own answers are kept.</p>
                )}
                {linkedApplication.note && <p className="app-note">{linkedApplication.note}</p>}
                {linkedApplication.note?.includes("Settings → Drafting") && <DraftingLink />}
              </div>
            )}
            {linkedApplication?.posting && (
              <p className="app-posting">Documents tailored from {postingSource(linkedApplication.posting.source)}.</p>
            )}
            {linkedApplication?.blockedReason && (
              <p className="blocked-reason"><strong>Blocked:</strong> {linkedApplication.blockedReason}</p>
            )}
            {linkedApplication && <AppIssues app={linkedApplication} />}
            {linkedApplication?.aiFilled?.length ? (
              <details className="ai-filled" open>
                <summary>Filled by AI: check these ({linkedApplication.aiFilled.length})</summary>
                <ul>
                  {linkedApplication.aiFilled.map((entry) => (
                    <li key={entry.label}>
                      <strong>{entry.label}</strong>: {entry.value}
                      {entry.caution && <p className="app-note">{entry.caution}</p>}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {linkedApplication && <FieldFallback key={`fallback:${linkedApplication.id}:${tabContext.tabId}`} app={linkedApplication} tabId={tabContext.tabId} profileRevision={profile.revision} disabled={busy || linkedFilling} draftOnly={Boolean(tabContext.draftOnly)} prerequisite={!connected ? "Connect the backend to review unfilled fields." : !profile.confirmed || !profile.facts.length ? "Save and confirm your background to review unfilled fields." : ""} onState={setQueue} />}
            {linkedApplication && <JobFitAssessment app={linkedApplication} profileRevision={profile.revision} onCheck={checkFit} disabled={busy} prerequisite={!connected ? "Connect the backend to check fit." : !profile.confirmed ? "Confirm your profile to check fit." : ""} />}
            {linkedApplication && <QuestionAnswers key={`${linkedApplication.id}:${tabContext.tabId}`} app={linkedApplication} tabId={tabContext.tabId} profileRevision={profile.revision} disabled={busy || linkedFilling} draftOnly={Boolean(tabContext.draftOnly)} autoFill={(queue.settings.modelFill || "auto") === "auto"} prerequisite={!connected ? "Connect the backend to draft answers." : !profile.confirmed || !profile.facts.length ? "Save and confirm your background to draft answers." : ""} onState={setQueue} />}
            {linkedApplication && postingMissing(linkedApplication) && <PostingPrompt app={linkedApplication} onSave={savePosting} />}
            <div className="context-actions">
              {tabContext.draftOnly ? (
                <p className="app-posting" role="note">
                  {DRAFT_ONLY_NOTE} Use the drafts above and Copy.
                </p>
              ) : (
                <button
                  className="primary"
                  disabled={busy || linkedFilling || Boolean(fillPrerequisite) || !((tabContext.fieldCount ?? tabContext.observation?.fields.length) || tabContext.frameOrigins?.length)}
                  onClick={() =>
                    void action(async () => {
                      // The form's own frame first, inside this click:
                      // Chrome grants access only to a user gesture.
                      if (tabContext.frameOrigins?.length && !(await chrome.permissions.request({ origins: tabContext.frameOrigins })))
                        throw new Error("Access to the application form's frame was not granted, so only the page around it can be filled.");
                      setQueue(
                        await command({
                          type: "FILL_STEP",
                          id: tabContext.applicationId,
                          tabId: tabContext.tabId,
                        }),
                      );
                    })
                  }
                >
                  {linkedFilling ? "Filling…" : "Fill this step"}
                </button>
              )}
              {linkedFilling && linkedApplication && (
                <button
                  className="secondary"
                  title="Stop this fill where it is. What it wrote stays on the page; choose Fill this step to carry on."
                  onClick={() =>
                    void action(
                      async () => setQueue(await command({ type: "PAUSE_APP", id: linkedApplication.id })),
                      "Fill paused. Choose Fill this step to carry on.",
                    )
                  }
                >
                  Pause fill
                </button>
              )}
              {linkedFilling && (
                <p className="fill-blocker" role="status">
                  Filling now. Scroll and read freely; typing or clicking a field pauses it.
                </p>
              )}
              {!linkedFilling && (fillPrerequisite || !((tabContext.fieldCount ?? tabContext.observation?.fields.length) || tabContext.frameOrigins?.length)) && (
                <p className="fill-blocker" role="status">
                  {fillPrerequisite || "Open a form step with fillable fields."}
                  {fillPrerequisite && (
                    <button className="text-button" onClick={() => setPage(connected ? "profile" : "settings")}>
                      {connected ? "Your profile" : "Settings"}
                    </button>
                  )}
                </p>
              )}
              {linkedApplication && linkedApplication.workflowStage !== "submitted" && (
                <button className="secondary" onClick={() => markSubmitted(linkedApplication.id)}>
                  Mark submitted
                </button>
              )}
              {linkedApplication && !finished(linkedApplication) && (
                <button className="secondary" onClick={() => abandon(linkedApplication)}>
                  Abandon
                </button>
              )}
              {linkedApplication && (
                <button
                  className="secondary"
                  disabled={busy || Boolean(linkedApplication.draftJobId)}
                  title="Tailors your resume and cover letter to this job and saves them as files. Nothing is written to the page."
                  onClick={() =>
                    void action(async () =>
                      setQueue(await command({ type: "DRAFT_DOCUMENTS", id: linkedApplication.id })),
                    )
                  }
                >
                  {linkedApplication.draftJobId
                    ? "Drafting documents…"
                    : linkedApplication.artifacts.length
                      ? "Redraft documents"
                      : "Draft documents"}
                </button>
              )}
              {/* Also here, where the applicant works: the Applications list is out of view. */}
              {linkedApplication?.missing.some((item) => /edit lock|locked by a trusted user edit/.test(item)) && (
                <button
                  className="secondary"
                  title="Fields you left empty are locked against filling. Unlock them so Fill this step can fill them; fields with a value are never overwritten."
                  onClick={() =>
                    void action(
                      async () => setQueue(await command({ type: "UNLOCK_APP", id: linkedApplication.id })),
                      "Empty fields unlocked. Choose Fill this step to fill them.",
                    )
                  }
                >
                  Unlock empty fields
                </button>
              )}
              {linkedApplication && linkedApplication.artifacts.length > 0 &&
                linkedApplication.missing.some((item) => /^Review existing document:/.test(item)) && (
                <button
                  className="secondary"
                  title="The site already held a document of its own (Amazon keeps your account's resume). Upload this application's tailored one in its place."
                  onClick={() =>
                    void action(
                      async () => setQueue(await command({ type: "REPLACE_DOCUMENTS", id: linkedApplication.id })),
                      "Replacing the site's document with this application's tailored one…",
                    )
                  }
                >
                  Replace with tailored resume
                </button>
              )}
              {linkedApplication?.missing.some((item) => /access|inspect frame/i.test(item)) && (
                <button className="secondary" onClick={() => void action(() => access(linkedApplication))}>
                  Grant frame access
                </button>
              )}
              {linkedApplication && linkedApplication.artifacts.length > 0 && (
                <button className="secondary" onClick={() => void action(() => documents(linkedApplication))}>
                  Documents
                </button>
              )}
              <button
                className="secondary"
                onClick={() => setIssueTarget({ tabId: tabContext.tabId, applicationId: tabContext.applicationId })}
              >
                Report issue
              </button>
              {linkedApplication && (
                <button
                  className="secondary"
                  disabled={busy}
                  title="Forget every lock and note from earlier attempts and reload this tab, so Fill this step starts as it would the first time. Your tailored documents are kept. Anything typed into the page is lost."
                  onClick={() =>
                    void action(
                      async () => setQueue(await command({ type: "RESTART_APP", id: linkedApplication.id })),
                      "Started over. Choose Fill this step when the page has loaded.",
                    )
                  }
                >
                  Start over (reloads tab)
                </button>
              )}
            </div>
            {linkedApplication?.draftError && (
              <p className="fill-blocker" role="alert">{linkedApplication.draftError}</p>
            )}
            {linkedApplication && uploadFiles(linkedApplication)}
            <details className="move-tab">
              <summary>Wrong application? Move this tab</summary>
              <input
                type="search"
                placeholder="Search applications"
                aria-label="Search applications to move this tab to"
                value={pickerQuery}
                onChange={(event) => setPickerQuery(event.target.value)}
              />
              <div className="row">
                <select
                  aria-label="Move this tab to"
                  value={attachChoice}
                  onChange={(event) => setAttachChoice(event.target.value)}
                >
                  <option value="">Choose application…</option>
                  {queue.applications
                    .filter((app) => !app.archivedAt && app.id !== tabContext.applicationId && matchesQuery(app, pickerQuery))
                    .map((app) => (
                      <option key={app.id} value={app.id}>{app.company} — {app.title}</option>
                    ))}
                </select>
                <button
                  className="secondary"
                  disabled={!attachChoice || attachChoice === tabContext.applicationId || busy}
                  onClick={() =>
                    void action(async () => {
                      await siteAccess(tabContext.url, tabContext.frameOrigins);
                      setQueue(await command({ type: "ATTACH_TAB", id: attachChoice, tabId: tabContext.tabId }));
                      setPickerQuery("");
                      await scanActive();
                    })
                  }
                >
                  Move tab
                </button>
              </div>
            </details>
            </>
          ) : (
            <div className="attach-controls">
              {tabContext.suggestions.length > 0 && (
                <p className="suggestion">
                  Suggested: <strong>{queue.applications.find((app) => app.id === tabContext.suggestions[0].applicationId)?.title}</strong>
                  <small>{tabContext.suggestions[0].reason}</small>
                </p>
              )}
              <input
                type="search"
                placeholder="Search applications"
                aria-label="Search applications to attach this tab to"
                value={pickerQuery}
                onChange={(event) => setPickerQuery(event.target.value)}
              />
              <label>
                Attach current tab
                <select value={attachChoice} onChange={(event) => setAttachChoice(event.target.value)}>
                  <option value="">
                    {queue.applications.some((app) => !app.archivedAt)
                      ? "Choose application…"
                      : "No tracked applications yet"}
                  </option>
                  {queue.applications.filter((app) => !app.archivedAt && (app.id === attachChoice || matchesQuery(app, pickerQuery))).map((app) => (
                    <option key={app.id} value={app.id}>{app.company} — {app.title}</option>
                  ))}
                </select>
              </label>
              <div className="context-actions">
                <button
                  className="primary"
                  disabled={!attachChoice || busy}
                  onClick={() =>
                    void action(async () => {
                      await siteAccess(tabContext.url, tabContext.frameOrigins);
                      setQueue(await command({ type: "ATTACH_TAB", id: attachChoice, tabId: tabContext.tabId }));
                      setPickerQuery("");
                      await scanActive();
                    })
                  }
                >
                  Attach tab
                </button>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await siteAccess(tabContext.url, tabContext.frameOrigins);
                      setQueue(await command({ type: "TRACK_TAB", tabId: tabContext.tabId }));
                      await scanActive();
                    })
                  }
                >
                  Track as new
                </button>
                <button className="text-button" onClick={() => setIssueTarget({ tabId: tabContext.tabId })}>
                  Report issue
                </button>
              </div>
            </div>
          )}
        </section>
      )}
      {!connected ? (
        checked && <ConnectCard
          onConnected={() => action(loadBackend, "Connected to Application Lane on this computer.")}
          onUseToken={() => setPage("settings")}
        />
      ) : (
        <OnboardingChecklist steps={onboardingSteps} />
      )}
      <Momentum progress={progress} ready={submissions !== undefined} />
      <div className="stats">
        <div>
          <strong>{progressing}</strong>
          <span>In progress</span>
        </div>
        <div>
          <strong>{ready}</strong>
          <span>Ready to review</span>
        </div>
        <div>
          <strong>{attention}</strong>
          <span>Need you</span>
        </div>
        <button className="stat-link" title="Every application that went in" onClick={() => void openDashboard("submitted")}>
          <strong>{submittedCount}</strong>
          <span>Submitted</span>
        </button>
      </div>
      {/* Links queued from the command line (npm run lane -- add) for sites
          this extension may not reach yet: Chrome grants that only from
          a click here. */}
      {Boolean(queue.inboxWaiting?.length) && (
        <section className="card" aria-label="Links waiting for access">
          <p>
            {queue.inboxWaiting!.length} link{queue.inboxWaiting!.length === 1 ? "" : "s"} queued from the command line
            {" "}need access to {new Set(queue.inboxWaiting!.map((url) => new URL(url).origin)).size === 1 ? "a site" : "some sites"} first.
          </p>
          <button
            className="primary"
            type="button"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                const origins = [...new Set(queue.inboxWaiting!.map((url) => `${new URL(url).origin}/*`))];
                if (!(await chrome.permissions.request({ origins })))
                  throw new Error("Site access was not granted, so those links were not tracked.");
                setQueue(await command<QueueState>({ type: "PICK_UP_INBOX" }));
              }, "Tracking the queued links.")
            }
          >
            Grant access and track
          </button>
        </section>
      )}
      <section className="card add-card">
        <div className="section-title add-title">
          <h2>Track application links</h2>
          <span className="tag">
            Filling starts only when requested
          </span>
        </div>
        <label className="sr-only" htmlFor="urls">
          Application URLs, one per line
        </label>
        <textarea
          id="urls"
          placeholder={
            "Paste application links, one per line\nhttps://jobs.company.com/your-next-role"
          }
          value={urls}
          onChange={(e) => setURLs(e.target.value)}
          rows={3}
        />
        <div className="row">
          <button
            className="secondary"
            onClick={() =>
              void action(async () => {
                const found = await chrome.tabs.query({
                  currentWindow: true,
                });
                setTabs(
                  found.filter((t) => /^https?:/.test(t.url || "")),
                );
                setShowTabs(!showTabs);
              })
            }
          >
            Choose open tabs
          </button>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void action(() =>
                add(
                  urls
                    .split("\n")
                    .map((u) => u.trim())
                    .filter(Boolean)
                    .map((url) => ({ url })),
                ),
              )
            }
          >
            <Icon type="plus" /> Track links
          </button>
        </div>
        {showTabs && (
          <div className="tab-picker">
            {tabs.length ? (
              tabs.map((tab) => (
                <label key={tab.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(tab.id!)}
                    onChange={(e) =>
                      setSelected((old) =>
                        e.target.checked
                          ? [...old, tab.id!]
                          : old.filter((id) => id !== tab.id),
                      )
                    }
                  />
                  <span>
                    {tab.title}
                    <small>{hostname(tab.url!)}</small>
                  </span>
                </label>
              ))
            ) : (
              <p>No application tabs in this window.</p>
            )}
            <button
              className="primary"
              disabled={!selected.length || busy}
              onClick={() =>
                void action(() =>
                  add(
                    tabs
                      .filter((t) => selected.includes(t.id!))
                      .map((t) => ({ url: t.url!, tabId: t.id })),
                  ),
                )
              }
            >
              Track {selected.length || "selected"} tabs
            </button>
          </div>
        )}
        <p className="micro">
          <Icon type="check" /> You review and submit every application
          yourself.
        </p>
      </section>
      <div className="section-title queue-heading">
        <h2>Your applications</h2>
        <div className="queue-tools">
          <input
            type="search"
            placeholder="Search"
            aria-label="Search applications"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <select
            aria-label="Filter applications"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="open">Open applications</option>
            <option value="all">All applications</option>
            <option value="active">Filling now</option>
            <option value="attention">Need attention</option>
            <option value="ready">Ready to review</option>
            <option value="submitted">Submitted</option>
            <option value="blocked">Blocked</option>
            <option value="abandoned">Abandoned</option>
          </select>
          <label className="archive-toggle">
            <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
            Archived
          </label>
        </div>
      </div>
      {!queue.applications.length ? (
        <div className="empty">
          <div className="empty-icon">
            <Icon type="layers" />
          </div>
          <h3>A clear path to your next role.</h3>
          <p>
            Add a few application links to begin.
            <br />
            We’ll keep each application in its own lane.
          </p>
          <div className="mini-flow">
            <span>Track jobs</span>
            <span>→</span>
            <span>Fill when ready</span>
            <span>→</span>
            <span>You review</span>
          </div>
        </div>
      ) : (
        <div className="applications">
          {!listed.length && (
            <p className="help">
              {filter === "open" && !search && !showArchived
                ? "No open applications. Submitted ones are under Submitted."
                : "No applications match."}
            </p>
          )}
          {listed
            .map((app) => (
              <article className={`application card${active.includes(app.status) && app.status !== "queued" ? " is-filling" : ""}`} data-stage={app.workflowStage} key={app.id}>
                <div className="application-top">
                  <span className="company-mark">
                    {hostname(app.url)
                      .replace(/^www\./, "")
                      .slice(0, 1)
                      .toUpperCase()}
                  </span>
                  <div className="job-name">
                    <h3>{app.title}</h3>
                    <span>
                      {hostname(app.url)}
                      {app.ats ? ` · ${app.ats}` : ""}
                    </span>
                  </div>
                  <span className={`status ${suggesting(app) ? "filling" : app.status}`}>
                    {suggesting(app) ? "Still filling" : labels[app.status]}
                  </span>
                </div>
                <div className="workflow-row">
                  <label>
                    Stage
                    <select
                      value={app.workflowStage}
                      onChange={(event) => {
                        const stage = event.target.value as WorkflowStage;
                        if (stage === "submitted" && !window.confirm("Mark this application as submitted? This updates the tracker only.")) return;
                        const reason = stage === "blocked" ? window.prompt("Why is this application blocked? (optional)") || "" : "";
                        void action(async () =>
                          setQueue(await command({ type: "SET_WORKFLOW", id: app.id, stage, reason })),
                        );
                      }}
                    >
                      <option value="applying">Applying</option>
                      <option value="review">Review</option>
                      <option value="submitted">Submitted</option>
                      <option value="blocked">Blocked</option>
                      <option value="abandoned">Abandoned</option>
                    </select>
                  </label>
                  <button
                    className="text-button muted"
                    onClick={() =>
                      void action(async () =>
                        setQueue(await command({ type: "ARCHIVE_APP", id: app.id, archived: !app.archivedAt })),
                      )
                    }
                  >
                    {app.archivedAt ? "Restore" : "Archive"}
                  </button>
                </div>
                <details className="application-details">
                  <summary>Edit position details</summary>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const values = new FormData(event.currentTarget);
                      void action(async () =>
                        setQueue(
                          await command({
                            type: "UPDATE_APP",
                            id: app.id,
                            company: values.get("company"),
                            title: values.get("title"),
                            postingUrl: String(values.get("postingUrl") || ""),
                            postingText: String(values.get("postingText") || ""),
                          }),
                        ),
                      );
                    }}
                  >
                    <label>
                      Company
                      <input name="company" defaultValue={app.company} />
                    </label>
                    <label>
                      Position
                      <input name="title" defaultValue={app.title} />
                    </label>
                    <label>
                      Job posting link
                      <input name="postingUrl" type="url" placeholder="https://…" defaultValue={app.postingUrl || ""} />
                    </label>
                    <label>
                      Or the posting's text
                      <textarea name="postingText" rows={3} defaultValue={app.postingText || ""} />
                    </label>
                    <button className="secondary" type="submit">Save details</button>
                  </form>
                </details>
                {["applying", "review"].includes(app.workflowStage) && <FillProgress app={app} />}
                <p className="app-note">{app.note}</p>
                {app.note?.includes("Settings → Drafting") && <DraftingLink />}
                {app.posting && (
                  <p className="app-posting">Documents tailored from {postingSource(app.posting.source)}.</p>
                )}
                {app.unchecked && <p className="app-unchecked">{uncheckedText(app.unchecked)}</p>}
                {app.blockedReason && (
                  <p className="blocked-reason"><strong>Blocked:</strong> {app.blockedReason}</p>
                )}
                {active.includes(app.status) &&
                  (app.status === "queued" ? (
                    <div className="progress">
                      <span />
                    </div>
                  ) : (
                    <FillLane />
                  ))}
                <TailoringBars app={app} />
                <AppIssues app={app} />
                <JobFitAssessment app={app} profileRevision={profile.revision} onCheck={checkFit} disabled={busy} prerequisite={!connected ? "Connect the backend to check fit." : !profile.confirmed ? "Confirm your profile to check fit." : ""} />
                {postingMissing(app) && <PostingPrompt app={app} onSave={savePosting} />}
                <div className="related-tabs" aria-label={`Tabs for ${app.title}`}>
                  {app.tabs.map((tab) => (
                    <div className={`related-tab ${app.tabId === tab.tabId ? "target" : ""}`} key={tab.id}>
                      <span className="tab-role">{tab.role}</span>
                      <span className="tab-copy">
                        <strong>{tab.title}</strong>
                        <small>{tab.state === "closed" ? "Closed" : `${app.tabId === tab.tabId ? "Current target · " : ""}${tab.state === "unscanned" ? "Not scanned" : `${tab.fieldCount} fields`} · ${hostname(tab.url)}`}</small>
                      </span>
                      {tab.tabId && (
                        <button className="icon-button compact" aria-label={`Open ${tab.title}`} title="Open tab" onClick={() => void action(() => command({ type: "OPEN_TAB", id: app.id, tabId: tab.tabId }))}>
                          <Icon type="external" />
                        </button>
                      )}
                      {tab.tabId && app.tabId !== tab.tabId && (
                        <button className="text-button" onClick={() => void action(async () => setQueue(await command({ type: "SET_TARGET", id: app.id, tabId: tab.tabId })))}>
                          Use
                        </button>
                      )}
                      {tab.tabId && (
                        <button className="icon-button compact" aria-label={`Detach ${tab.title}`} title="Detach tab" onClick={() => void action(async () => setQueue(await command({ type: "DETACH_TAB", id: app.id, tabId: tab.tabId })))}>
                          ×
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {app.attempts.length > 0 && (
                  <details className="attempt-history">
                    <summary>Fill history ({app.attempts.length})</summary>
                    {app.attempts.slice().reverse().map((attempt) => (
                      <div className="attempt-row" key={attempt.id}>
                        <span>{new Date(attempt.startedAt).toLocaleString()}</span>
                        <strong>{attempt.status}</strong>
                        <small>{attempt.filled} fields{attempt.note ? ` · ${attempt.note}` : ""}</small>
                      </div>
                    ))}
                  </details>
                )}
                <div className="app-footer">
                  <small>
                    {app.filled} fields filled
                    {app.issueCount ? ` · ${app.issueCount} issue${app.issueCount === 1 ? "" : "s"}` : ""}
                    {app.preparationMs !== undefined
                      ? ` · ${Math.round(app.preparationMs / 1000)}s active`
                      : ""}
                  </small>
                  <div className="actions">
                    {app.tabId && !active.includes(app.status) && app.status !== "cancelled" && (
                      <>
                        <button className="primary small" hidden={draftOnlySite(app.url)} disabled={busy || Boolean(fillPrerequisite)} onClick={() => void action(async () => setQueue(await command({ type: "FILL_STEP", id: app.id })))}>
                          Fill this step
                        </button>
                        {fillPrerequisite && <small className="fill-blocker">{fillPrerequisite}</small>}
                        {!draftOnlySite(app.url) && app.workflowStage !== "submitted" && (
                          <StepButtons app={app} settings={queue.settings} disabled={busy} send={command} run={action} onState={setQueue} />
                        )}
                      </>
                    )}
                    {app.workflowStage !== "submitted" && (
                      <button className="text-button" onClick={() => markSubmitted(app.id)}>
                        Mark submitted
                      </button>
                    )}
                    {app.missing.some((item) => /edit lock|locked by a trusted user edit/.test(item)) && (
                      <button
                        className="text-button"
                        title="Fields you left empty are locked against filling. Unlock them so Fill this step can fill them; fields with a value are never overwritten."
                        onClick={() =>
                          void action(
                            async () => setQueue(await command({ type: "UNLOCK_APP", id: app.id })),
                            "Empty fields unlocked. Choose Fill this step to fill them.",
                          )
                        }
                      >
                        Unlock empty fields
                      </button>
                    )}
                    {active.includes(app.status) ? (
                      <button
                        className="text-button"
                        onClick={() =>
                          void action(() =>
                            command({ type: "PAUSE_APP", id: app.id }),
                          )
                        }
                      >
                        Pause
                      </button>
                    ) : null}
                    {app.missing.some((m) =>
                      /access|inspect frame/i.test(m),
                    ) && (
                      <button
                        className="text-button"
                        onClick={() => void action(() => access(app))}
                      >
                        Grant frame access
                      </button>
                    )}
                    {app.artifacts.length > 0 && (
                      <button
                        className="text-button"
                        onClick={() => void action(() => documents(app))}
                      >
                        Documents
                      </button>
                    )}
                    <button
                      className="text-button"
                      onClick={() =>
                        void action(() =>
                          command({ type: "OPEN_APP", id: app.id }),
                        )
                      }
                    >
                      Open <Icon type="external" />
                    </button>
                    {app.tabId && (
                      <button className="text-button" onClick={() => setIssueTarget({ tabId: app.tabId!, applicationId: app.id })}>
                        Report issue
                      </button>
                    )}
                    {app.status !== "cancelled" && (
                      <button
                        className="text-button muted"
                        onClick={() =>
                          void action(() =>
                            command({ type: "CANCEL_APP", id: app.id }),
                          )
                        }
                      >
                        Abandon
                      </button>
                    )}
                  </div>
                </div>
              </article>
            ))}
        </div>
      )}
      <div className="quiet-note">
        <Icon type="pause" />
        <p>
          <strong>Your edits come first.</strong> Start editing an
          application and its active fill pauses. Other requested fills
          keep moving.
        </p>
      </div>
    </>
  );
}
