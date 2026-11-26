// The panel's settings page (panel.tsx, App): its markup, moved as it was.
import { ConnectCard } from "../onboarding";
import { extensionBuild, describeBuild } from "../../shared/build";
import { DraftingSettings } from "../drafting-settings";
import { storeBuild } from "../../shared/store-build";
import { Appearance } from "../appearance";
import { emptyProfile, withPermissions, type SignaturePolicy } from "../../shared/model";
import { Icon, api, command, type PanelState } from "../panel";

export function SettingsPage({ panel }: { panel: PanelState }) {
  const { action, busy, checked, connected, deleteConfirm, deleteDocuments, loadBackend, pairToken, profile, queue, setDeleteConfirm, setDeleteDocuments, setIssues, setPairToken, setProfile, setQueue, waitingBuild } = panel;
  // What a fill may agree to and sign: Settings once set here, until then
  // what an older version saved on Your profile (withPermissions).
  const permissions = withPermissions(profile, queue.settings);
  return (
    <>
      <div className="eyebrow">LOCAL BY DESIGN</div>
      <h1>
        Your tools.
        <br />
        <span>Your connection.</span>
      </h1>
      <p className="lede">
        The extension prepares forms in your browser. Your local backend
        handles documents and AI requests.
      </p>
      <section className="card">
        <div className="section-title">
          <h2>Backend connection</h2>
          <span className={`status ${connected ? "ready" : "paused"}`}>
            {connected ? "Connected" : checked ? "Not connected" : "Connecting…"}
          </span>
        </div>
        {!connected && checked && <ConnectCard onConnected={() => action(loadBackend, "Connected to Application Lane on this computer.")} />}
        <p className="help">
          The backend runs on this computer (<code>npm start</code> in the
          Application Lane folder). Connect with the six-digit code it shows,
          or paste the 64-character token from <code>config.json</code> in
          its data folder (not the Chrome extension ID). To move to another
          browser or extension, restart it with <code>npm start -- --pair</code>{" "}
          (or run <code>lane pair</code>) and type the new code.
        </p>
        <p className="help">
          This extension was built {extensionBuild ? describeBuild(extensionBuild) : "without a build stamp"}.
          {waitingBuild ? ` A newer build is ready: ${describeBuild(waitingBuild)}.` : ""}
        </p>
        <label>
          Pairing token
          <input
            type="password"
            autoComplete="off"
            value={pairToken}
            onChange={(e) => setPairToken(e.target.value)}
            placeholder="Local pairing token"
          />
        </label>
        <div className="row">
          <button
            className="secondary"
            onClick={() =>
              void action(loadBackend, "Connection refreshed.")
            }
          >
            Refresh connection
          </button>
          <button
            className="primary"
            disabled={busy || !pairToken}
            onClick={() =>
              void action(async () => {
                await command({ type: "PAIR", token: pairToken });
                setPairToken("");
                await loadBackend();
              }, "Local backend connected.")
            }
          >
            Connect <Icon type="arrow" />
          </button>
        </div>
      </section>
      <DraftingSettings connected={connected} />
      <section className="card">
        <h2>Processing</h2>
        <p className="help">
          Fill requests you explicitly start may run together. The extension
          never starts another step or clicks Next on its own. Thorough
          checking adds about half a minute per application.
        </p>
        <div className="form-grid">
          <label>
            Simultaneous fills
            <select
              value={queue.settings.concurrency}
              onChange={(e) =>
                setQueue((q) => ({
                  ...q,
                  settings: {
                    ...q.settings,
                    concurrency: Number(e.target.value),
                  },
                }))
              }
            >
              {[1, 2, 3, 4, 6, 8].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <label>
            Applications drafted at once
            <select
              value={queue.settings.generationConcurrency}
              onChange={(e) =>
                setQueue((q) => ({
                  ...q,
                  settings: {
                    ...q.settings,
                    generationConcurrency: Number(e.target.value),
                  },
                }))
              }
            >
              {[1, 2, 3, 4].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <label>
            Document checking
            <select
              value={queue.settings.checking || "thorough"}
              onChange={(e) =>
                setQueue((q) => ({
                  ...q,
                  settings: {
                    ...q.settings,
                    checking: e.target.value === "fast" ? "fast" : "thorough",
                  },
                }))
              }
            >
              <option value="thorough">Thorough: another model in your Drafting order checks every claim (slower)</option>
              <option value="fast">Fast: no second check</option>
            </select>
          </label>
          <label>
            AI filling
            <select
              value={queue.settings.modelFill === "written" ? "auto" : queue.settings.modelFill || "auto"}
              onChange={(e) =>
                setQueue((q) => ({
                  ...q,
                  settings: {
                    ...q.settings,
                    modelFill: e.target.value === "review" ? "review" : e.target.value === "off" ? "off" : "auto",
                  },
                }))
              }
            >
              <option value="auto">Fill automatically: AI answers go into the form, marked for you to check</option>
              <option value="review">Review first: AI drafts, you approve before anything is filled</option>
              <option value="off">Profile only: fill just what matches my saved details</option>
            </select>
          </label>
          <label>
            Next step button
            <select
              value={queue.settings.nextButton || "on"}
              onChange={(e) =>
                setQueue((q) => ({ ...q, settings: { ...q.settings, nextButton: e.target.value === "off" ? "off" : "on" } }))
              }
            >
              <option value="on">Show it: press the page's Next or Continue from the panel</option>
              <option value="off">Hide it: I press Next on the page</option>
            </select>
          </label>
          <label>
            Submit button
            <select
              value={queue.settings.submitButton || "off"}
              onChange={(e) =>
                setQueue((q) => ({ ...q, settings: { ...q.settings, submitButton: e.target.value === "on" ? "on" : "off" } }))
              }
            >
              <option value="off">Hide it: I submit on the page</option>
              <option value="on">Show it: submit from the panel after a summary I confirm</option>
            </select>
          </label>
          <label>
            Legal and eligibility questions
            <select
              value={queue.settings.legalQuestions || "manual"}
              onChange={(e) =>
                setQueue((q) => ({
                  ...q,
                  settings: {
                    ...q.settings,
                    legalQuestions: e.target.value === "model" ? "model" : "manual",
                  },
                }))
              }
            >
              <option value="manual">Leave for me unless my profile answers them (they are listed)</option>
              <option value="model">Let AI answer them like any other question</option>
            </select>
          </label>
          <label>
            Terms and consent boxes
            <select
              value={permissions.acknowledgeTerms ? "on" : "off"}
              onChange={(e) =>
                setQueue((q) => ({ ...q, settings: { ...q.settings, agreeToTerms: e.target.value === "on" ? "on" : "off" } }))
              }
            >
              <option value="off">Leave them for me</option>
              <option value="on">Tick boxes agreeing to terms, a privacy notice or a certification</option>
            </select>
          </label>
          <label>
            Signatures
            <select
              value={permissions.signatures}
              onChange={(e) =>
                setQueue((q) => ({ ...q, settings: { ...q.settings, signatures: e.target.value as SignaturePolicy } }))
              }
            >
              <option value="never">Leave every signature for me</option>
              <option value="self-id">Sign self-identification forms (disability, veteran)</option>
              <option value="all">Sign every form, including attestations</option>
            </select>
            <small className="help">
              Signing types your full name into a signature box and dates it today. It is a legal
              signature, made for you: check the form before you submit it.
            </small>
          </label>
          <label>
            Pre-filled answers
            <select
              value={queue.settings.prefilled || "replace"}
              onChange={(e) =>
                setQueue((q) => ({
                  ...q,
                  settings: {
                    ...q.settings,
                    prefilled: e.target.value === "keep" ? "keep" : "replace",
                  },
                }))
              }
            >
              <option value="replace">Replace with my profile (your edits are kept)</option>
              <option value="keep">Keep what the site filled in</option>
            </select>
          </label>
          <label>
            Resume already on a form
            <select
              value={queue.settings.existingResume || "replace"}
              onChange={(e) =>
                setQueue((q) => ({
                  ...q,
                  settings: {
                    ...q.settings,
                    existingResume: e.target.value === "keep" ? "keep" : "replace",
                  },
                }))
              }
            >
              <option value="replace">Replace it with the resume tailored for the posting</option>
              <option value="keep">Keep it (Replace with tailored resume stays on the card)</option>
            </select>
          </label>
          <label>
            Tab groups
            <select
              value={queue.settings.tabGroups === "off" ? "off" : "on"}
              onChange={(e) =>
                setQueue((q) => ({ ...q, settings: { ...q.settings, tabGroups: e.target.value === "off" ? "off" : "on" } }))
              }
            >
              <option value="on">Group application tabs by stage</option>
              <option value="off">Leave tabs as they are</option>
            </select>
            <small className="help">
              Application tabs sit in Chrome tab groups named for where they stand (Needs you, In progress,
              Ready to review…), as the command line's tabs show them. Groups you make yourself are left alone.
            </small>
          </label>
          {!storeBuild && typeof chrome.debugger !== "undefined" && (
          <label>
            Network capture for reports
            <select
              value={queue.settings.networkCapture === "on" ? "on" : "off"}
              onChange={(e) =>
                setQueue((q) => ({
                  ...q,
                  settings: {
                    ...q.settings,
                    networkCapture: e.target.value === "off" ? "off" : "on",
                  },
                }))
              }
            >
              <option value="off">Off</option>
              <option value="on">On: reports can be replayed</option>
            </select>
            <small className="help">
              While on, Chrome shows its "started debugging this browser" bar on application tabs, and
              the pages' network traffic (addresses, form data, responses) is recorded and saved with
              issue reports on this computer.
            </small>
          </label>
          )}
        </div>
        <button
          className="secondary"
          disabled={!connected || busy}
          onClick={() =>
            void action(
              async () =>
                setQueue(
                  await command({
                    type: "SETTINGS",
                    settings: queue.settings,
                  }),
                ),
              "Processing settings saved.",
            )
          }
        >
          Save settings
        </button>
      </section>
      <Appearance />
      <section className="card">
        <h2>Your data</h2>
        <p className="help">
          Profile facts and job content are sent to your configured AI
          endpoint for tailoring. The extension does not collect telemetry
          or share your browser history. API keys stay in the local
          backend. Cancelling an application leaves its existing page
          values in place.
        </p>
        <p className="help">
          Initial adapters: Workday, Greenhouse, Lever, Ashby, and iCIMS.
          Other sites use general form matching. Login, CAPTCHAs,
          inaccessible frames, and unknown controls may require you.
        </p>
        {deleteConfirm ? (
          <div className="notice error">
            <p>
              Delete your saved profile, application tracker, generated documents, issue reports
              and the page traffic saved with them, fill captures, recordings, job searches, the
              fixer's results and transcripts uploaded here? Your settings and pairing stay.
              This cannot be undone.
            </p>
            <label>
              <input
                type="checkbox"
                checked={deleteDocuments}
                onChange={(e) => setDeleteDocuments(e.target.checked)}
              />{" "}
              Also delete the documents saved to your documents folder
            </label>
            <button
              className="danger"
              onClick={() =>
                void action(async () => {
                  await api(deleteDocuments ? "/v1/data?documents=1" : "/v1/data", "DELETE");
                  setProfile(structuredClone(emptyProfile));
                  setIssues([]);
                  setDeleteConfirm(false);
                }, "Profile, tracker, documents, and issue reports deleted. Existing application pages were not cleared.")
              }
            >
              Delete local application data
            </button>
            <button
              className="text-button"
              onClick={() => setDeleteConfirm(false)}
            >
              Keep data
            </button>
          </div>
        ) : (
          <button
            className="text-button danger-text"
            onClick={() => setDeleteConfirm(true)}
          >
            Delete local application data…
          </button>
        )}
      </section>
    </>
  );
}
