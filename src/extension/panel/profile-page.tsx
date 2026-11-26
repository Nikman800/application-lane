// The panel's profile page (panel.tsx, App): its markup, moved as it was.
import { OnboardingChecklist, ConnectCard } from "../onboarding";
import { type Profile, legalDetailLabels, type LegalDetailKey, type RoleOverride } from "../../shared/model";
import { WorkAuthorizationEditor, CareerEditor, SalaryEditor, LocaleEditor } from "../profile-fields";
import { RecurringAnswers } from "../recurring-answers";
import { ChoiceSelect, Icon, LegalDetail, TranscriptPicker, api, type PanelState } from "../panel";

export function ProfilePage({ panel }: { panel: PanelState }) {
  const { action, busy, cleanLines, conflicts, connected, dispatchProfile, edit, exportProfile, importProfile, importResumes, imports, loadBackend, onboardingSteps, profile, setNotice, setPage, setProfile } = panel;
  return (
    <>
      {connected && <OnboardingChecklist steps={onboardingSteps} />}
      <div className="eyebrow">THE FACTS BEHIND EVERY APPLICATION</div>
      <h1>
        Your experience.
        <br />
        <span>Ready to travel.</span>
      </h1>
      <p className="lede">
        Confirm what’s true once. Tailored documents select and order
        these facts without inventing qualifications.
      </p>
      {conflicts.length > 0 && (
        <div className="notice" role="status" aria-label="Profile disagreements">
          <strong>This profile and your tailoring notes disagree.</strong> Form
          fields use the saved profile. Written drafts can draw on the notes.
          <ul>
            {conflicts.map((c) => (
              <li key={c.field}>
                {c.field}: here “{c.extension}”, {c.file} “{c.markdown}”
              </li>
            ))}
          </ul>
        </div>
      )}
      {!connected ? (
        <ConnectCard
          onConnected={() => action(loadBackend, "Connected to Application Lane on this computer.")}
          onUseToken={() => setPage("settings")}
        />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              const normalized = {
                ...profile,
                skills: cleanLines(profile.skills),
                skillLevels: Object.fromEntries(
                  Object.entries(profile.skillLevels || {}).filter(([skill]) => cleanLines(profile.skills).includes(skill)),
                ),
                languages: cleanLines(profile.languages),
                referralSource: cleanLines(profile.referralSource),
                // A country row added but never chosen says nothing.
                workAuthorization: (profile.workAuthorization || []).filter((entry) => entry.country),
              };
              setProfile(
                await api<Profile>("/v1/profile", "PUT", normalized),
              );
            }, "Profile saved. Resume paused applications to use these facts.");
          }}
        >
          <section className="card">
            <div className="section-title">
              <h2>Start with your resume</h2>
              <span className="tag">PDF or DOCX · 10 MB max</span>
            </div>
            <label className="upload">
              <Icon type="plus" />
              <span>
                {busy ? "Working…" : "Add resumes to your facts"}
              </span>
              <input
                type="file"
                accept=".pdf,.docx"
                multiple
                disabled={busy}
                aria-label="Add resumes to your facts"
                onChange={(e) => {
                  const files = Array.from(e.currentTarget.files || []);
                  e.currentTarget.value = "";
                  if (!files.length) return;
                  void action(() => importResumes(files));
                }}
              />
            </label>
            <p className="micro">
              Select up to 10 resumes at once. New facts are added to your
              existing list; exact duplicates are skipped. Original files
              are not saved.
            </p>
            <p className="help">
              Differing versions stay separate for you to review. Check
              dates, quantities, and wording, then confirm and save the
              cumulative list.
            </p>
            {imports.length > 0 && (
              <div role="status" aria-label="Resume import results">
                {imports.map((report, index) => (
                  <p
                    className={report.error ? "notice error" : "help"}
                    key={index}
                  >
                    <strong>{report.name}</strong>:{" "}
                    {report.error ||
                      `${report.added} facts added, ${report.duplicates} duplicates skipped.`}
                  </p>
                ))}
              </div>
            )}
          </section>
          <section className="card">
            <h2>Contact details</h2>
            <div className="form-grid">
              {(
                [
                  "firstName",
                  "middleName",
                  "lastName",
                  "preferredName",
                  "namePronunciation",
                  "email",
                  "phoneCountryCode",
                  "phone",
                  "phoneDeviceType",
                  "address",
                  "addressLine2",
                  "city",
                  "state",
                  "county",
                  "postalCode",
                  "country",
                  "linkedin",
                  "website",
                  "github",
                  "currentCompany",
                ] as const
              ).map((key) => (
                <label key={key}>
                  {(
                    {
                      firstName: "First name",
                      lastName: "Last name",
                      middleName: "Middle name (optional)",
                      postalCode: "Postal code",
                      linkedin: "LinkedIn URL",
                      preferredName: "Preferred first name (optional)",
                      namePronunciation: "How your name is said (optional)",
                      github: "GitHub URL (optional)",
                      currentCompany: "Current company (optional)",
                      phoneDeviceType: "Phone device type",
                      phoneCountryCode: "Phone country code (e.g. +44)",
                      phone: "Phone number (without the country code)",
                      addressLine2: "Address line 2 (optional)",
                    } as any
                  )[key] || key[0].toUpperCase() + key.slice(1)}
                  <input
                    type={key === "email" ? "email" : "text"}
                    value={profile[key] || ""}
                    onChange={(e) => edit(key, e.target.value)}
                    required={["firstName", "lastName", "email"].includes(
                      key,
                    )}
                  />
                </label>
              ))}
            </div>
          </section>
          <WorkAuthorizationEditor profile={profile} edit={edit} />
          <section className="card">
            <h2>Application answer bank</h2>
            <p className="help">
              These confirmed choices are reused only for matching standard
              application questions. Leave any answer blank to handle it
              yourself.
            </p>
            <div className="form-grid">
              <CareerEditor profile={profile} edit={edit} />
              {(["dateOfBirth", "age18OrOlder", "willingToRelocate", "internshipCount"] as const).map((key) => (
                <label key={key}>
                  {({ dateOfBirth: "Date of birth (for age questions)", age18OrOlder: "Age 18 or older", willingToRelocate: "Willing to relocate", internshipCount: "Prior internships / co-ops" } as const)[key]}
                  {key === "dateOfBirth" ? (
                    <input
                      type="date"
                      value={profile.dateOfBirth}
                      onChange={(e) => edit("dateOfBirth", e.target.value)}
                    />
                  ) : key === "internshipCount" ? (
                    <input
                      type="number"
                      min={0}
                      max={99}
                      step={1}
                      placeholder="e.g. 2"
                      value={profile.internshipCount}
                      onChange={(e) => edit("internshipCount", e.target.value.trim())}
                    />
                  ) : (
                    <ChoiceSelect field={key} value={profile[key]} onChange={(value) => edit(key, value)} />
                  )}
                </label>
              ))}
              <SalaryEditor profile={profile} edit={edit} />
              <LocaleEditor profile={profile} edit={edit} />
            </div>
            <label>
              <input
                type="checkbox"
                checked={profile.neverWorkedForApplyingCompanies === true}
                onChange={(e) => edit("neverWorkedForApplyingCompanies", e.target.checked ? true : undefined)}
              />{" "}
              I have never worked for any company I apply to. (Without this, "Have you worked here before?" is
              answered Yes only when your work history names the employer, and otherwise left for you.)
            </label>
            <label>
              Skills (one per line)
              <textarea
                rows={5}
                value={profile.skills.join("\n")}
                onChange={(e) =>
                  edit("skills", e.target.value.split("\n"))
                }
                onBlur={() => edit("skills", cleanLines(profile.skills))}
              />
            </label>
            {cleanLines(profile.skills).length > 0 && (
              <div className="grid">
                {cleanLines(profile.skills).map((skill) => (
                  <label key={skill}>
                    {skill} level
                    <select
                      value={profile.skillLevels?.[skill] ?? ""}
                      onChange={(e) => {
                        const next = { ...(profile.skillLevels || {}) };
                        if (e.target.value) next[skill] = Number(e.target.value);
                        else delete next[skill];
                        edit("skillLevels", next);
                      }}
                    >
                      <option value="">–</option>
                      {["Beginner", "Basic", "Proficient", "Advanced", "Expert"].map((name, index) => (
                        <option key={name} value={index + 1}>
                          {index + 1} {name}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            )}
            <label>
              <input
                type="checkbox"
                checked={profile.fillSkillLevels === true}
                onChange={(e) => edit("fillSkillLevels", e.target.checked)}
              />{" "}
              Fill skill proficiency levels on applications (optional questions)
            </label>
            <label>
              Languages, one per line with how well (English: Native,
              Hindi: Fluent, Spanish: Basic)
              <textarea
                rows={3}
                value={profile.languages.join("\n")}
                onChange={(e) =>
                  edit("languages", e.target.value.split("\n"))
                }
                onBlur={() => edit("languages", cleanLines(profile.languages))}
              />
            </label>
            <label>
              Where you hear about jobs, in preference order (one per
              line, such as LinkedIn or Company website; not a
              person's name). Left empty, "How did you hear about us?"
              is answered Application Lane, as Other where a list
              does not name it
              <textarea
                rows={4}
                value={profile.referralSource.join("\n")}
                onChange={(e) =>
                  edit("referralSource", e.target.value.split("\n"))
                }
                onBlur={() =>
                  edit(
                    "referralSource",
                    cleanLines(profile.referralSource),
                  )
                }
              />
            </label>
          </section>
          <section className="card">
            <h2>U.S. equal-opportunity questions (optional)</h2>
            <p className="help">
              Voluntary self-identification as U.S. employers ask it. These
              answer only questions worded the U.S. way; any other
              country's diversity questions are left for you.
            </p>
            <div className="form-grid">
              {(["disabilityStatus", "veteranStatus", "gender", "pronouns", "sexualOrientation", "transgender", "ethnicity", "hispanic"] as const).map((key) => (
                <label key={key}>
                  {({ disabilityStatus: "Disability status", veteranStatus: "Veteran status", gender: "Gender", pronouns: "Pronouns", sexualOrientation: "Sexual orientation", transgender: "Identify as transgender", ethnicity: "Ethnicity", hispanic: "Hispanic / Latino" } as const)[key]}
                  <ChoiceSelect field={key} value={profile[key]} onChange={(value) => edit(key, value)} />
                </label>
              ))}
            </div>
          </section>
          <section className="card">
            <div className="section-title">
              <h2>Move your profile</h2>
            </div>
            <p className="help">
              Export saves everything on this page, your tailoring files
              (resumes, profile and preference notes, question guides) and
              your settings as one file. Import replaces what is here with
              a file exported elsewhere. Passwords, API keys, applications
              and generated documents are never included.
            </p>
            <div className="context-actions">
              <button type="button" className="secondary" disabled={busy} onClick={() => void action(exportProfile, "Profile exported. The file holds personal details: keep it somewhere private.")}>
                Export profile
              </button>
              <label className="secondary file-button">
                Import profile…
                <input
                  type="file"
                  accept=".json,application/json"
                  disabled={busy}
                  aria-label="Import profile"
                  onChange={(e) => {
                    const file = e.currentTarget.files?.[0];
                    e.currentTarget.value = "";
                    if (!file) return;
                    if (!window.confirm("Replace the profile, tailoring files and settings here with the ones in this file?")) return;
                    void action(async () => {
                      const files = await importProfile(file);
                      setNotice(`Profile imported${files ? `, with ${files} tailoring file${files === 1 ? "" : "s"}` : ""}. Check it, then confirm.`);
                    });
                  }}
                />
              </label>
            </div>
          </section>
          <section className="card">
            <div className="section-title">
              <h2>Legal and eligibility details</h2>
            </div>
            <p className="help">
              Choose what is true of you, or write it in your own words.
              Questions about your record, clearance, agreements and the
              like are answered only from what you save here, including
              boxes that ask you to explain. Leave any of them for
              yourself to answer that kind by hand.
            </p>
            <div className="form-grid">
              {(Object.keys(legalDetailLabels) as LegalDetailKey[]).map((key) => (
                <LegalDetail
                  key={key}
                  topic={key}
                  value={profile.legal?.[key] || ""}
                  onChange={(value) => edit("legal", { ...profile.legal, [key]: value })}
                />
              ))}
            </div>
          </section>
          <section className="card">
            <div className="section-title">
              <h2>Cumulative resume facts</h2>
              <span className="tag">
                {profile.facts.length} / 300 facts
              </span>
            </div>
            <p className="help">
              One complete fact per line. Include skills, achievements,
              and experience you can support. These lines form the
              evidence for your documents.
            </p>
            <textarea
              rows={12}
              aria-label="Resume facts"
              value={profile.facts.map((f) => f.text).join("\n")}
              onChange={(e) =>
                edit(
                  "facts",
                  e.target.value.split("\n").map((text, i) => ({
                    id: profile.facts[i]?.id || crypto.randomUUID(),
                    text,
                  })),
                )
              }
            />
          </section>
          {(["work", "education"] as const).map((kind) => (
            <section className="card" key={kind}>
              <div className="section-title">
                <h2>
                  {kind === "work" ? "Work experience" : "Education"}
                </h2>
                <button
                  className="text-button"
                  type="button"
                  onClick={() =>
                    edit(kind, [
                      ...profile[kind],
                      {
                        organization: "",
                        title: "",
                        startDate: "",
                        endDate: "",
                        location: "",
                        details: "",
                      },
                    ])
                  }
                >
                  + Add entry
                </button>
              </div>
              {profile[kind].map((row, index) => (
                <div className="history-row" key={index}>
                  <div className="form-grid">
                    {(
                      [
                        "organization",
                        "title",
                        "startDate",
                        "endDate",
                        "location",
                        "details",
                        ...(kind === "education"
                          ? ["fieldOfStudy" as const]
                          : []),
                        "address",
                        "city",
                        "state",
                        "county",
                        "postalCode",
                        "country",
                        ...(kind === "work"
                          ? ["reasonForLeaving" as const]
                          : []),
                      ] as const
                    ).map((key) => (
                      <label key={key}>
                        {
                          {
                            organization:
                              kind === "work"
                                ? "Employer"
                                : "Institution",
                            title:
                              kind === "work" ? "Job title" : "Degree",
                            startDate: "Start date (YYYY-MM-DD)",
                            endDate: kind === "education" ? "End or expected graduation date (YYYY-MM-DD)" : "End date (YYYY-MM-DD, blank = present)",
                            location: "Location",
                            details: "Details",
                            fieldOfStudy: "Major / field of study",
                            address: "Street address (optional)",
                            city: "City (optional)",
                            state: "State / province (optional)",
                            county: "County (optional)",
                            postalCode: "Zip / postal code (optional)",
                            country: "Country (optional)",
                            reasonForLeaving: "Reason for leaving (optional)",
                          }[key]
                        }
                        <input
                          value={row[key] || ""}
                          placeholder={key === "startDate" || key === "endDate" ? "2025-08-19" : undefined}
                          pattern={key === "startDate" || key === "endDate" ? "\\d{4}-\\d{2}(-\\d{2})?" : undefined}
                          // Trimmed when the field is left, not as it
                          // is typed: trimming each keystroke swallowed
                          // every space typed at the end of the text.
                          onChange={(e) =>
                            edit(
                              kind,
                              profile[kind].map((r, i) =>
                                i === index
                                  ? { ...r, [key]: e.target.value }
                                  : r,
                              ),
                            )
                          }
                          onBlur={(e) =>
                            edit(
                              kind,
                              profile[kind].map((r, i) =>
                                i === index
                                  ? { ...r, [key]: e.target.value.trim() }
                                  : r,
                              ),
                            )
                          }
                        />
                        {(key === "startDate" || key === "endDate") &&
                          /^\d{4}-\d{2}$/.test(row[key] || "") && (
                            <small className="fill-blocker">
                              Add the day ({row[key]}-DD). Forms that ask for a day use the 1st until you do.
                            </small>
                          )}
                      </label>
                    ))}
                    {kind === "education" && (
                      <>
                        <label>
                          GPA or grade (optional)
                          <input
                            value={row.gpa || ""}
                            placeholder="e.g. 3.62, 8.7, 85"
                            maxLength={20}
                            onChange={(e) =>
                              edit(kind, profile[kind].map((r, i) => (i === index ? { ...r, gpa: e.target.value.trim() || undefined } : r)))
                            }
                          />
                        </label>
                        <label>
                          GPA scale
                          <select
                            value={row.gpaScale || ""}
                            onChange={(e) =>
                              edit(kind, profile[kind].map((r, i) => (i === index ? { ...r, gpaScale: (e.target.value || undefined) as typeof r.gpaScale } : r)))
                            }
                          >
                            <option value="">Not said</option>
                            <option value="4">Out of 4</option>
                            <option value="5">Out of 5</option>
                            <option value="10">Out of 10</option>
                            <option value="100">Out of 100 (percentage)</option>
                            <option value="other">Another scale</option>
                          </select>
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={row.current === true}
                            onChange={(e) =>
                              edit(kind, profile[kind].map((r, i) => (i === index ? { ...r, current: e.target.checked } : r)))
                            }
                          />{" "}
                          I am still studying here
                        </label>

                        <TranscriptPicker
                          value={row.transcript}
                          onChange={(name) =>
                            edit(kind, profile[kind].map((r, i) => (i === index ? { ...r, transcript: name } : r)))
                          }
                        />
                      </>
                    )}
                  </div>
                  <button
                    className="text-button muted"
                    type="button"
                    onClick={() =>
                      edit(
                        kind,
                        profile[kind].filter((_, i) => i !== index),
                      )
                    }
                  >
                    Remove entry
                  </button>
                </div>
              ))}
            </section>
          ))}
          <section className="card">
            <div className="section-title">
              <h2>Professional references</h2>
              <button
                className="text-button"
                type="button"
                onClick={() =>
                  edit("references", [
                    // An older backend answers without the field.
                    ...(profile.references || []),
                    { name: "", relationship: "", phone: "", email: "" },
                  ])
                }
              >
                + Add reference
              </button>
            </div>
            <p className="help">
              People an employer may contact. These fill a form's
              reference rows, and a single "list your references" box in
              the order shown here.
            </p>
            {(profile.references || []).map((reference, index) => (
              <div className="history-row" key={index}>
                <div className="form-grid">
                  {(
                    ["name", "relationship", "phone", "email"] as const
                  ).map((key) => (
                    <label key={key}>
                      {
                        {
                          name: "Name",
                          relationship: "Relationship",
                          phone: "Phone number",
                          email: "Email",
                        }[key]
                      }
                      <input
                        value={reference[key] || ""}
                        onChange={(e) =>
                          edit(
                            "references",
                            (profile.references || []).map((r, i) =>
                              i === index
                                ? { ...r, [key]: e.target.value }
                                : r,
                            ),
                          )
                        }
                      />
                    </label>
                  ))}
                </div>
                <button
                  className="text-button muted"
                  type="button"
                  onClick={() =>
                    edit(
                      "references",
                      (profile.references || []).filter(
                        (_, i) => i !== index,
                      ),
                    )
                  }
                >
                  Remove reference
                </button>
              </div>
            ))}
          </section>
          <section className="card" aria-label="Differences by job type">
            <div className="section-title">
              <h2>Differences by job type</h2>
              <button
                className="text-button"
                type="button"
                onClick={() =>
                  edit("roleOverrides", [
                    ...(profile.roleOverrides || []),
                    (profile.roleOverrides || []).some((override) => override.name === "Internships & co-ops")
                      ? { name: "New job type", titleWords: [], education: [] }
                      : { name: "Internships & co-ops", titleWords: ["intern", "internship", "co-op", "summer analyst", "summer associate"], education: [] },
                  ])
                }
              >
                + Add job type
              </button>
            </div>
            <p className="help">
              Set a different graduation date or full-time availability for some
              jobs. A job whose title has one of a type's
              words is filled with these values instead; the first type
              that matches is used.
            </p>
            {(profile.roleOverrides || []).map((override, index) => {
              const change = (update: Partial<RoleOverride>) =>
                edit("roleOverrides", (profile.roleOverrides || []).map((other, at) => (at === index ? { ...other, ...update } : other)));
              return (
                <div className="history-row" key={index}>
                  <div className="form-grid">
                    <label>
                      Name
                      <input value={override.name} maxLength={80} onChange={(e) => change({ name: e.target.value })} />
                    </label>
                    <label>
                      Available to work full-time hours for this job type
                      <select value={override.availableFullTime === undefined ? "" : String(override.availableFullTime)}
                        onChange={(e) => change({ availableFullTime: e.target.value ? e.target.value === "true" : undefined })}>
                        <option value="">Use profile default</option>
                        <option value="true">Yes</option>
                        <option value="false">No</option>
                      </select>
                    </label>
                    <label>
                      Job title words (comma-separated)
                      <input
                        value={override.titleWords.join(", ")}
                        placeholder="intern, internship, co-op"
                        onChange={(e) => change({ titleWords: e.target.value.split(",").map((word) => word.trim()).filter(Boolean).slice(0, 20) })}
                      />
                    </label>
                    {profile.education.map((row, rowIndex) => (
                      <label key={rowIndex}>
                        End date at {row.organization || `education ${rowIndex + 1}`} (optional)
                        <input
                          value={override.education.find((entry) => entry.index === rowIndex)?.endDate || ""}
                          placeholder={row.endDate || "YYYY-MM-DD"}
                          maxLength={20}
                          onChange={(e) =>
                            change({
                              education: [
                                ...override.education.filter((entry) => entry.index !== rowIndex),
                                ...(e.target.value.trim() ? [{ index: rowIndex, endDate: e.target.value.trim() }] : []),
                              ].sort((a, b) => a.index - b.index),
                            })
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <button
                    className="text-button muted"
                    type="button"
                    onClick={() => edit("roleOverrides", (profile.roleOverrides || []).filter((_, at) => at !== index))}
                  >
                    Remove job type
                  </button>
                </div>
              );
            })}
          </section>
          <RecurringAnswers
            profileRevision={profile.revision}
            onSaved={(saved) => {
              dispatchProfile({ type: "edit", update: saved });
              setNotice("Saved. Later fills give this answer.");
            }}
          />
          <section className="card">
            <div className="section-title">
              <h2>Reusable answers</h2>
              <button
                className="text-button"
                type="button"
                onClick={() =>
                  edit("answers", [
                    ...profile.answers,
                    { question: "", answer: "" },
                  ])
                }
              >
                + Add answer
              </button>
            </div>
            <p className="help">
              Answers match the same question and recognized variants of
              common questions, such as willingness to take a coding test.
              Dedicated profile fields and job-type overrides take precedence.
            </p>
            {profile.answers.map((answer, index) => (
              <div className="history-row" key={index}>
                <label>
                  Question
                  <input
                    value={answer.question}
                    onChange={(e) =>
                      edit(
                        "answers",
                        profile.answers.map((a, i) =>
                          i === index
                            ? { ...a, question: e.target.value }
                            : a,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  Your answer
                  <input
                    value={answer.answer}
                    onChange={(e) =>
                      edit(
                        "answers",
                        profile.answers.map((a, i) =>
                          i === index
                            ? { ...a, answer: e.target.value }
                            : a,
                        ),
                      )
                    }
                  />
                </label>
                <button
                  className="text-button muted"
                  type="button"
                  onClick={() =>
                    edit(
                      "answers",
                      profile.answers.filter((_, i) => i !== index),
                    )
                  }
                >
                  Remove answer
                </button>
              </div>
            ))}
          </section>
          <div className="confirm">
            <label>
              <input
                type="checkbox"
                checked={profile.confirmed}
                onChange={(e) => edit("confirmed", e.target.checked)}
              />{" "}
              I’ve checked these details and confirm they are accurate.
            </label>
            <button
              className="primary"
              disabled={
                busy ||
                !profile.confirmed ||
                !profile.facts.length ||
                profile.facts.some((f) => !f.text.trim())
              }
              type="submit"
            >
              Save confirmed profile <Icon type="check" />
            </button>
          </div>
        </form>
      )}
    </>
  );
}
