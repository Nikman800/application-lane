// The panel's issues page (panel.tsx, App): its markup, moved as it was.
import { type Recording } from "../../shared/model";
import { FixerProblems, api, command, fixerLabels, hostname, type PanelState } from "../panel";

export function IssuesPage({ panel }: { panel: PanelState }) {
  const { action, copyIssue, exportIssue, issues, recordings, saveBlob, setIssues, setQueue, setRecordings, shareIssue } = panel;
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">LOCAL DIAGNOSTICS</div>
          <h1>Issue reports</h1>
        </div>
      </div>
      <p className="help">
        Reports stay on this computer until you delete them. Exporting a
        report includes its captured form markup and entered values.
      </p>
      {!issues.length ? (
        <div className="empty compact-empty">
          <h3>No saved reports</h3>
          <p>Use Report issue from the current tab or an application.</p>
        </div>
      ) : (
        <div className="issue-list">
          {issues.map((issue) => (
            <article className="issue-row" key={issue.id}>
              <div>
                <span className="tag">{issue.category.replaceAll("-", " ")}</span>
                <h3>{issue.application?.title || issue.tab.title}</h3>
                <small>
                  {new Date(issue.createdAt).toLocaleString()} · {hostname(issue.tab.url)}
                  {issue.recordingId ? " · with recording" : ""}
                  {issue.network ? ` · network ${issue.network.fromLoad ? "from page load" : "(after load)"}` : ""}
                </small>
                {issue.note && <p>{issue.note}</p>}
                {issue.fixer && (
                  <p className={`fixer-status ${issue.fixer.status}`}>
                    <strong>{fixerLabels[issue.fixer.status]}</strong>
                    {issue.fixer.commit ? ` (${issue.fixer.commit.slice(0, 7)})` : ""}
                    {issue.fixer.summary ? `: ${issue.fixer.summary}` : ""}
                    {issue.fixer.cause && <span className="fixer-cause"> Cause: {issue.fixer.cause}</span>}
                    {issue.fixer.liveCheck && <span className="live-check"> Check on the live site: {issue.fixer.liveCheck}</span>}
                  </p>
                )}
                {issue.fixer && <FixerProblems result={issue.fixer} />}
              </div>
              <div className="actions">
                <button className="text-button" onClick={() => void action(() => shareIssue(issue.id))}>Share on GitHub</button>
                <button className="text-button" onClick={() => void action(() => exportIssue(issue.id))}>Export JSON</button>
                <button className="text-button" onClick={() => void action(() => copyIssue(issue.id), "Markdown summary copied.")}>Copy summary</button>
                <button
                  className="text-button muted"
                  onClick={() =>
                    void action(async () => {
                      setQueue(await command({ type: "DELETE_ISSUE", reportId: issue.id }));
                      setIssues((current) => current.filter((item) => item.id !== issue.id));
                    })
                  }
                >
                  Delete
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      <div className="section-title recordings-heading">
        <h2>Page recordings</h2>
      </div>
      <p className="help">
        Recordings show what happened on a page (clicks, typing, menus
        and options, network requests, and every field before and after)
        while you or another tool filled it. They include entered values
        and stay on this computer until you delete them.
      </p>
      {!recordings.length ? (
        <div className="empty compact-empty">
          <h3>No recordings</h3>
          <p>Use Record page activity from the current tab.</p>
        </div>
      ) : (
        <div className="issue-list">
          {recordings.map((recording) => (
            <article className="issue-row" key={recording.id}>
              <div>
                <span className="tag">recording</span>
                <h3>{recording.tab.title}</h3>
                <small>
                  {new Date(recording.createdAt).toLocaleString()} · {hostname(recording.tab.url)} ·{" "}
                  {Math.round(recording.durationMs / 1000)}s · {recording.eventCount} events
                  {recording.pages.length > 1 ? ` · ${recording.pages.length} pages` : ""}
                </small>
                {recording.summary && (
                  <small className="recording-summary">
                    {recording.summary.valueChanges} field changes, {recording.summary.directChanges} set directly
                    {Object.entries(recording.summary.callsBySource).map(([source, count]) => (
                      <span key={source}>
                        {" · "}
                        {count} page-function calls by{" "}
                        {source === "injected" ? "injected code" : source.replace(/^extension:/, "extension ")}
                      </span>
                    ))}
                  </small>
                )}
              </div>
              <div className="actions">
                <button
                  className="text-button"
                  onClick={() =>
                    void action(async () => {
                      const full = await api<Recording>(`/v1/recordings/${recording.id}`);
                      saveBlob(
                        `application-lane-recording-${recording.id}.json`,
                        JSON.stringify(full, null, 2),
                        "application/json",
                      );
                    })
                  }
                >
                  Export JSON
                </button>
                <button
                  className="text-button muted"
                  onClick={() =>
                    void action(async () => {
                      await api(`/v1/recordings/${recording.id}`, "DELETE");
                      setRecordings((current) => current.filter((item) => item.id !== recording.id));
                    })
                  }
                >
                  Delete
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
