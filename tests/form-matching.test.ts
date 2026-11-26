import { fieldFallbackSources } from "../src/server/field-fallback";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  profileSchema,
  type Field,
  type Application,
} from "../src/shared/model";
import { canonicalAnswer, pickOption as pickListOption } from "../src/shared/answers";
import { deterministicAnswer, nameVariants, postingGuess, proposals, publicPostingUrl, untickedNo } from "../src/shared/matching";
import { configPassTimeout, transitionTiming } from "../src/shared/timing";
import { degreeAliases } from "../src/shared/education";
import { localDate } from "../src/shared/dates";
import { profileFactQuestion } from "../src/shared/profile-facts";

test("authorization never invents documentary proof or temporary immigration status", () => {
  const p = us(profile, "Yes", "No");
  for (const label of ["Can you provide proof that you are authorized to work in the United States?", "Do you have temporary work authorization?"]) {
    for (const options of [[], ["Yes", "No"]])
      assert.deepEqual(proposals([field(label, { kind: "combobox", options })], p), [], label);
  }
  const label = "Can you provide proof that you are authorized to work in the United States?";
  assert.equal(proposals([field(label, { kind: "combobox", options: ["Yes", "No"] })], {
    ...p, answers: [{ question: label, answer: "No" }],
  })[0]?.value, "No");
});

test("confirmed school-name prompts and direct postal requests never answer unrelated school facts", () => {
  for (const label of ["College/University", "College or University", "Current University", "Please select your current or most recent university.", "Which university will you graduate from?", "Please include the university you are currently enrolled in.", "Which institution do you currently attend/have most recently attended?", "Which institution do you currently or most recently attend?", "Which university are you currently attending? Select Other if not listed", "Please re-confirm the university you currently attend", "What college/university are currently enrolled?", "Which college or university do you currently attend?", "What is the name of your University?", "Which University do/did you attend?", "What University do you currently attend?", "What college/university did you attend?"])
    assert.equal(proposals([field(label)], profile)[0]?.value, "Test University", label);
  for (const label of ["University GPA", "College enrollment status", "University email", "Which university did your parent attend?", "Which university will you graduate from and when?"])
    assert.equal(deterministicAnswer(field(label), profile), undefined, label);
  assert.deepEqual(proposals([field("Current University")], { ...profile, education: [] }), []);
  // The school is not in the list: its Other is the answer (a different school is never picked).
  assert.deepEqual(proposals([field("Please select your current or most recent university.", { kind: "combobox", options: ["Other", "A Different University"] })], profile).map((p) => p.value), ["Other"]);
  assert.deepEqual(proposals([field("Please select your current or most recent university.", { kind: "combobox", options: ["A Different University"] })], profile), []);
  for (const label of ["Please enter the ZIP code of your primary residence in the United States.", "Please provide your Post Code/ ZIP code."])
    assert.equal(deterministicAnswer(field(label), profile), "85001");
  assert.equal(deterministicAnswer(field("Please provide your full permanent address (city, state and ZIP)"), profile), undefined);
  assert.equal(deterministicAnswer(field("How did you hear about Zipline?"), profile), undefined);
});

test("state picker abbreviations require the corresponding confirmed country and state", () => {
  const picker = field("State", { kind: "combobox", options: ["AK", "AZ"] });
  assert.equal(proposals([picker], profile)[0]?.value, "AZ");
  assert.deepEqual(proposals([picker], { ...profile, country: "Unknown" }), []);
  assert.deepEqual(proposals([field("State", { kind: "combobox", options: ["AK"] })], profile), []);
});

test("a location-address helper uses confirmed location facts, while commute ability stays unknown", () => {
  assert.equal(proposals([field("Address (city, region, country)")], profile)[0]?.value, "Phoenix, Arizona, United States");
  assert.equal(proposals([field("Address")], profile)[0]?.value, "100 Test Way");
  assert.deepEqual(proposals([field("Address (city, region, country)")], { ...profile, city: "" }), []);
  const onsite = { ...profile, answers: [{ question: "Are you willing to work onsite?", answer: "Yes" }] };
  assert.deepEqual(proposals([field("Are you able to commute to our Boulder office five days a week?", { kind: "radio", options: ["YES", "NO"] })], onsite), []);
});

test("education aliases preserve degree level and specialization", () => {
  const options = ["Bachelor's", "Bachelor of Arts", "Master's"];
  const science = profileSchema.parse({ ...profile, education: [{ ...profile.education[0], title: "Bachelor of Science" }] });
  assert.equal(proposals([field("Degree", { kind: "select", options })], science)[0]?.value, "Bachelor's");
  assert.deepEqual(proposals([field("Degree", { kind: "select", options: ["Bachelor of Arts", "Master's"] })], science), []);
  assert.equal(degreeAliases("BS").includes("Bachelor of Science"), true);
  assert.equal(degreeAliases("Unknown certificate").length, 0);
  // A plural level ("Masters of Science") is the same degree: one employer's
  // Workday lists "Master of Science", and both Degree boxes stayed empty.
  assert.equal(degreeAliases("Masters of Science")[0], "Master of Science");
  assert.equal(degreeAliases("Bachelors of Science")[0], "Bachelor of Science");
  assert.equal(degreeAliases("Bachelors of Arts")[0], "Bachelor of Arts");
  // Still never another specialization.
  assert.equal(degreeAliases("Masters of Science").includes("Master of Arts"), false);
  assert.equal(deterministicAnswer(field("School"), science), science.education[0].organization);
  assert.equal(deterministicAnswer(field("Current location"), science), science.city);
  assert.equal(deterministicAnswer(field("Where are you currently located?"), science), science.city);
  // Reports (Ashby): "(City, State)" got the country as well, and
  // "Preferred Last Name" was left empty.
  assert.equal(proposals([field("Where are you currently located? (City, State)")], science)[0]?.value, [science.city, science.state].filter(Boolean).join(", "));
  assert.equal(proposals([field("Where are you currently located? (City, State, Country)")], science)[0]?.value, [science.city, science.state, science.country].filter(Boolean).join(", "));
  assert.equal(proposals([field("Preferred Last Name")], science)[0]?.value, science.lastName);
  // A report (an employer, Greenhouse): "…to work in the country in
  // which you are applying" names no country; the list was left empty.
  const sponsored = proposals([field("Will you now or in the future require employer sponsorship or other employer assistance to obtain, extend, or maintain authorization to work in the country in which you are applying for a position ?", { kind: "combobox" })], us(science, "", "No"))[0];
  assert.equal(sponsored?.value, "No");
  assert.equal(proposals([field("Will you require sponsorship to work in which country?", { kind: "combobox" })], us(science, "", "No"))[0], undefined);
  // one employer's Workday: "the country or jurisdiction where the
  // position to which you are applying is located" names none either.
  const bank = us(science, "Yes", "No");
  assert.equal(proposals([field("Will you, now or in the future, require sponsorship for employment in the country or jurisdiction where the position to which you are applying is located?", { kind: "combobox" })], bank)[0]?.value, "No");
  assert.equal(proposals([field("Are you legally authorized to work in the country or jurisdiction where the position to which you are applying is located?", { kind: "combobox" })], bank)[0]?.value, "Yes");
  // one employer's Workday asks the job's country, then "that country", its options unread until the list opens.
  assert.equal(proposals([field("Will you require employer support to obtain or maintain authorization to work in that country? e.g. (work permit)", { kind: "combobox" })], bank)[0]?.value, "No");
  // one employer's Workday lists "Authorized" and "Not Authorized".
  assert.equal(proposals([field("Are you legally authorized to work in the United States?", { kind: "combobox", options: ["Authorized", "Not Authorized"] })], bank)[0]?.value, "Authorized");
  // Microsoft's careers site words it "country/region".
  assert.equal(proposals([field("Are you legally authorized to work in the country/region you are applying for?", { kind: "combobox" })], bank)[0]?.value, "Yes");
  // Being authorized does not say the applicant can produce the documents.
  assert.equal(proposals([field("Can you, within the time period prescribed by law, submit verification of both your identity and authorization to work in the country or jurisdiction where the position to which you are applying is located? (Proof will be required)", { kind: "combobox" })], bank)[0], undefined);
  // one employer's form: "the location associated with this job
  // posting" names no place, and "legal authorization to work" is asked.
  const epic = us(science, "Yes", "No");
  assert.equal(proposals([field("Do you now, or will you in the future, require sponsorship for employment authorization in order to legally work in the location associated with this job posting?", { kind: "combobox" })], epic)[0]?.value, "No");
  assert.equal(proposals([field("Do you have legal authorization to work in the geographic region specified for the internship?", { kind: "combobox" })], epic)[0]?.value, "Yes");
  assert.equal(proposals([field("Are you willing to work in the location of this role?", { kind: "combobox" })], epic)[0], undefined);
  // A report (Greenhouse): the race list loads its options only
  // when opened, and was left empty.
  const race = proposals([field("Please identify your race", { kind: "combobox", required: false })], { ...science, ethnicity: "South Asian" })[0]!;
  assert.equal(pickListOption(race, ["American Indian or Alaskan Native", "Asian", "Black or African American", "White"], (option) => option), "Asian");
  assert.equal(pickListOption(race, ["Asian", "South Asian", "White"], (option) => option), "South Asian");
  assert.equal(proposals([field("Please identify your race", { kind: "combobox", required: false })], { ...science, ethnicity: "" })[0], undefined);
  // A report (Greenhouse): a question about one project, with its
  // description and challenges, was answered with the GitHub profile.
  const linked = { ...science, github: "github.com/example" };
  assert.equal(proposals([field("Can you provide a link to a recent project you’ve worked on? Please include a brief description of the project, any challenges you faced, and the link to it.", { kind: "textarea" })], linked)[0]?.value, undefined);
  assert.equal(proposals([field("Please share a link to your projects or GitHub")], linked)[0]?.value, "https://github.com/example");
  // A report (Greenhouse): the phone country list says "United
  // States +1"; the profile says "United States of America".
  const american = { ...science, country: "United States of America" };
  const phoneCountry = proposals([field("Country", { kind: "select", options: ["Canada +1", "United States +1", "United Kingdom +44"] })], american)[0]!;
  assert.equal(pickListOption(phoneCountry, ["Canada +1", "United States +1", "United Kingdom +44"], (option) => option), "United States +1");
  // Amazon asks it as a question.
  const located = proposals([field("What country/region are you currently located?", { kind: "select", options: ["Canada", "United States"] })], american)[0]!;
  assert.equal(pickListOption(located, ["Canada", "United States"], (option) => option), "United States");
  // Tesla's "Country/Region of Residence": a
  // select of 258 countries the fill never tried.
  const tesla = ["American Samoa", "Belarus", "United Arab Emirates", "United Kingdom", "United States"];
  const residence = proposals([field("Country/Region of Residence", { kind: "select", options: tesla })], american)[0]!;
  assert.equal(pickListOption(residence, tesla, (option) => option), "United States");
  assert.equal(deterministicAnswer(field("Desired location"), science), undefined);
  assert.equal(deterministicAnswer(field("Date"), science), undefined);
  assert.equal(deterministicAnswer(field("Do you agree to relocate?"), science), undefined);
});

const profile = profileSchema.parse({
  firstName: "Alex",
  lastName: "Fixture",
  email: "alex@example.test",
  confirmed: true,
  address: "100 Test Way",
  city: "Phoenix",
  state: "Arizona",
  postalCode: "85001",
  country: "United States",
  facts: [],
  education: [
    {
      organization: "Test University",
      title: "Bachelor's Degree",
      fieldOfStudy: "Computer Science",
      startDate: "2024-08",
      endDate: "2028-05",
    },
  ],
});
const field = (label: string, overrides: Partial<Field> = {}): Field => ({
  id: "fixture",
  label,
  kind: "text",
  required: true,
  value: "",
  options: [],
  revision: 1,
  protected: false,
  ...overrides,
});

// PageUp labels its address fields "Postcode/ZIP:" and
// "State / District:"; neither was answered from the profile.
test("a postcode and a state asked for under their regional names are answered from the profile", () => {
  for (const label of ["Postcode/ZIP:", "Postcode", "Post code", "ZIP / Postal code"])
    assert.equal(deterministicAnswer(field(label), profile), profile.postalCode, label);
  for (const label of ["State / District:", "State / Province / Region", "State/Territory"])
    assert.equal(deterministicAnswer(field(label), profile), profile.state, label);
  assert.equal(deterministicAnswer(field("Postcode of your school"), profile), undefined);
});

// SuccessFactors (optimumcareers): the state is
// "State/Province/Parish", the repeated email "Retype Email Address", the
// phone's country list "Country/Region Code" ("United States (+1)"), and the
// school is a radio group of schools with an Other and no box for a name.
// None was answered before the AI fallback.
test("SuccessFactors' State/Province/Parish, Retype Email Address and Country/Region Code are answered from the profile", () => {
  assert.equal(proposals([field("State/Province/Parish", { kind: "combobox" })], profile)[0]?.value, "Arizona");
  assert.equal(proposals([field("Retype Email Address")], profile)[0]?.value, "alex@example.test");
  assert.equal(proposals([field("Confirm your email address")], profile)[0]?.value, "alex@example.test");
  const codes = ["United States (+1)", "Canada (+1)", "Afghanistan (+93)"];
  assert.equal(proposals([field("Country/Region Code", { kind: "select", options: codes })], profile)[0]?.value, "United States (+1)");
});

test("a radio group of schools without the applicant's school is answered Other, with no box for a name", () => {
  const schools = ["Contoso University", "Fabrikam Institute (FI)", "Other"];
  const ask = (options: string[]) =>
    proposals([field("What school are you currently attending?", { kind: "radio", options, section: "What school are you currently attending?" })], profile);
  assert.deepEqual(ask(schools).map((p) => p.value), ["Other"]);
  // A listed school is chosen itself.
  assert.deepEqual(ask(["Contoso University", "Test University", "Other"]).map((p) => p.value), ["Test University"]);
  // No Other, no answer.
  assert.deepEqual(ask(["Contoso University"]), []);
});

// PageUp pre-fills "Home address line two" from the
// account's older address; the profile's address has no second line.
test("a second address line the site kept from another address is emptied, or replaced with the profile's", () => {
  const stale = (label: string, overrides: Partial<Field> = {}) =>
    field(label, { required: false, value: "Oldtown ZZ", siteValue: true, ...overrides });
  for (const label of ["Home address line two", "Address Line 2", "Street address 2", "Address 2:"]) {
    const [proposal] = proposals([stale(label)], profile);
    assert.equal(proposal?.value, "", label);
    assert.equal(proposal?.expectedValue, "Oldtown ZZ", label);
  }
  const suite = profileSchema.parse({ ...profile, addressLine2: "Suite 4" });
  assert.equal(proposals([stale("Home address line two")], suite)[0]?.value, "Suite 4");
  assert.equal(proposals([field("Address line 2")], suite)[0]?.value, "Suite 4");
  // Nothing to empty, the applicant's own entry, or no address to go by.
  assert.deepEqual(proposals([field("Address line 2")], profile), []);
  assert.deepEqual(proposals([stale("Address line 2", { siteValue: false })], profile), []);
  assert.deepEqual(
    proposals([stale("Address line 2")], profileSchema.parse({ ...profile, address: "" })),
    [],
  );
  // Other pre-filled fields the profile cannot answer are left as they are.
  assert.deepEqual(proposals([stale("Middle name")], profile), []);
});

// one employer's iCIMS: the site's parser put
// "Hyderabad" under a job the profile says was remote.
test("a place the site parsed for a remote job is emptied", () => {
  const remote = profileSchema.parse({
    ...profile,
    work: [
      { organization: "Example Labs", title: "Engineer", location: "Lansing, MI", startDate: "2024-01", endDate: "", details: "" },
      { organization: "Solo Studio", title: "Founder", location: "Remote", startDate: "2025-03", endDate: "", details: "" },
    ],
  });
  const parsed = (label: string, index: number, overrides: Partial<Field> = {}) =>
    field(label, { required: false, value: "Hyderabad", siteValue: true, section: "Professional Experience", index, ...overrides });
  for (const label of ["City", "Address", "Postal Code", "State"])
    assert.equal(proposals([parsed(label, 1)], remote)[0]?.value, "", label);
  // A job with a place keeps its own; the applicant's own entry and a
  // school's place are left alone.
  assert.equal(proposals([parsed("City", 0)], remote)[0]?.value, "Lansing");
  assert.deepEqual(proposals([parsed("City", 1, { siteValue: false })], remote), []);
  assert.deepEqual(proposals([parsed("City", 1, { section: "Education" })], remote), []);
});

// SuccessFactors (Contoso) pre-fills "Home/Area Code"
// and "Home Phone #" from the account's older number; neither was replaced
// with the profile's.
test("a home phone and area code the site kept from an older number are replaced with the profile's", () => {
  const phoned = profileSchema.parse({ ...profile, phone: "+1 (555) 201-0199" });
  const stale = (label: string, value: string) => field(label, { value, siteValue: true });
  assert.equal(proposals([stale("* Home/Area Code", "999")], phoned)[0]?.value, "555");
  assert.equal(proposals([stale("* Home Phone #", "9990000000")], phoned)[0]?.value, phoned.phone);
  for (const label of ["Area Code", "Home Phone Number", "Cell Phone #", "Mobile Phone"])
    assert.ok(deterministicAnswer(field(label), phoned), label);
  // The same number is left as it is; an area code only comes from a North
  // American number.
  assert.deepEqual(proposals([stale("Home/Area Code", "555")], phoned), []);
  assert.equal(deterministicAnswer(field("Area Code"), profileSchema.parse({ ...profile, phone: "+44 20 7946 0000" })), undefined);
  assert.equal(deterministicAnswer(field("Area Code"), profile), undefined);
});

// PageUp pre-fills "Education status:" with "Completed"
// from the resume; a degree still under way was never corrected.
test("an education status is answered from the degree's end date, and a wrong pre-filled one is replaced", () => {
  const status = (overrides: Partial<Field> = {}) =>
    field("Education status:", {
      kind: "combobox",
      section: "Highest level of education",
      ...overrides,
    });
  const [ongoing] = proposals([status({ value: "Completed", siteValue: true })], profile);
  assert.equal(ongoing?.value, "In progress");
  assert.equal(ongoing?.expectedValue, "Completed");
  const options = ["Select", "All But Dissertation", "Completed", "In progress", "Incomplete"];
  assert.equal(proposals([status({ kind: "select", options })], profile)[0]?.value, "In progress");
  const finished = profileSchema.parse({
    ...profile,
    education: [{ ...profile.education[0], endDate: "2020-05" }],
  });
  assert.equal(proposals([status()], finished)[0]?.value, "Completed");
  // Already right, no end date to go by, or a status outside education.
  assert.deepEqual(proposals([status({ value: "Completed", siteValue: true })], finished), []);
  const undated = profileSchema.parse({
    ...profile,
    education: [{ ...profile.education[0], endDate: "" }],
  });
  assert.deepEqual(proposals([status({ value: "Completed", siteValue: true })], undated), []);
  assert.deepEqual(proposals([status({ section: "Work experience" })], profile), []);
});

test("contact aliases fill exact confirmed values, default the preferred name, and do not invent a current company", () => {
  assert.equal(
    deterministicAnswer(field("email", { kind: "textarea" }), profile),
    profile.email,
  );
  assert.equal(
    deterministicAnswer(field("Home address", { kind: "textarea" }), profile),
    "100 Test Way\nPhoenix, Arizona, 85001\nUnited States",
  );
  assert.equal(
    deterministicAnswer(field("Preferred First Name"), profile),
    profile.firstName,
  );
  assert.equal(
    deterministicAnswer(field("Current company"), profile),
    undefined,
  );
  const completed = {
    ...profile,
    preferredName: "Al",
    github: "https://github.com/fixture",
    currentCompany: "Current Co",
    website: "https://example.test",
  };
  assert.equal(
    deterministicAnswer(field("Preferred First Name"), completed),
    "Al",
  );
  assert.equal(
    deterministicAnswer(field("* First & Last Name"), profile),
    `${profile.firstName} ${profile.lastName}`,
  );
  // Oracle's "Preferred Full Name": the preferred first name, then the last.
  assert.equal(
    deterministicAnswer(field("Preferred Full Name"), profile),
    `${profile.firstName} ${profile.lastName}`,
  );
  assert.equal(
    deterministicAnswer(field("Preferred Full Name"), completed),
    `Al ${profile.lastName}`,
  );
  assert.equal(
    deterministicAnswer(field("GitHub URL"), completed),
    completed.github,
  );
  assert.equal(
    deterministicAnswer(field("Other website"), completed),
    completed.website,
  );
  assert.equal(
    deterministicAnswer(field("Current company"), completed),
    completed.currentCompany,
  );
});

test("education dates split into exact month/year options and never invent missing days", () => {
  const inEducation = (label: string, overrides: Partial<Field> = {}) =>
    field(label, { section: "Education", index: 0, ...overrides });
  assert.equal(
    deterministicAnswer(inEducation("School Dropdown"), profile),
    "Test University",
  );
  assert.equal(
    deterministicAnswer(inEducation("Major"), profile),
    "Computer Science",
  );
  assert.equal(
    deterministicAnswer(inEducation("Start Date Year"), profile),
    "2024",
  );
  assert.equal(
    deterministicAnswer(
      inEducation("End date month", { kind: "combobox" }),
      profile,
    ),
    "May",
  );
  assert.equal(
    proposals(
      [
        inEducation("Start Date Month", {
          kind: "select",
          options: ["Jan", "Aug", "Dec"],
        }),
      ],
      profile,
    )[0].value,
    "Aug",
  );
  assert.equal(
    deterministicAnswer(inEducation("Start Date Day"), profile),
    undefined,
  );
  assert.equal(
    deterministicAnswer(inEducation("Start date", { kind: "date" }), profile),
    undefined,
  );
  // With a full date, day lists and date inputs use the real day.
  const dated = {
    ...profile,
    education: [{ ...profile.education[0], startDate: "2024-08-05" }],
  };
  assert.equal(
    deterministicAnswer(
      inEducation("Start Date Day", {
        kind: "select",
        options: Array.from({ length: 31 }, (_, i) => String(i + 1)),
      }),
      dated,
    ),
    "5",
  );
  assert.equal(
    deterministicAnswer(inEducation("Start date", { kind: "date" }), dated),
    "2024-08-05",
  );
  // Answered from the end date: still ahead means not yet graduated.
  assert.equal(
    deterministicAnswer(inEducation("Did You Graduate?"), profile),
    "No",
  );
  assert.equal(
    deterministicAnswer(inEducation("Did You Graduate?"), {
      ...profile,
      education: [{ ...profile.education[0], endDate: "2020-05" }],
    }),
    "Yes",
  );
  assert.equal(
    deterministicAnswer(inEducation("Start Date Year", { index: 2 }), profile),
    undefined,
  );
});

test("consent, initials, and signatures stay manual even when an exact answer was saved", () => {
  for (const question of [
    "PLEASE INITIAL EACH PARAGRAPH BEFORE SIGNING",
    "I understand this agreement",
    "I authorize you to contact my prior employers",
    "I hereby certify this information is correct",
  ]) {
    assert.equal(
      deterministicAnswer(field(question), {
        ...profile,
        answers: [{ question, answer: "Yes" }],
      }),
      undefined,
    );
  }
  const question = "Are you legally authorized to work in the United States?";
  assert.equal(
    deterministicAnswer(field(question), {
      ...profile,
      answers: [{ question, answer: "Yes" }],
    }),
    "Yes",
  );
});

test("active duration excludes paused and queued time, including overnight waits", () => {
  const app = { status: "queued" } as Application;
  transitionTiming(app, "inspecting", 1000);
  transitionTiming(app, "preparing", 1200);
  transitionTiming(app, "paused", 1500);
  transitionTiming(app, "queued", 50_000_000);
  transitionTiming(app, "filling", 50_100_000);
  transitionTiming(app, "ready", 50_100_400);
  assert.equal(app.preparationMs, 900);
  assert.equal(app.activeSince, undefined);
});

test("GPA, internships, pronouns and orientation match each portal's wording", () => {
  const answering = profileSchema.parse({
    ...profile,
    gpa: "3.62",
    internshipCount: "0",
    pronouns: "He/Him",
    sexualOrientation: "Straight",
  });
  const pick = (label: string, options: string[], who = answering) =>
    proposals([field(label, { kind: "select", options })], who)[0]?.value;
  // The Klaviyo (Greenhouse) option lists.
  const gpaOptions = ["Below 2", "2 - 2.24", "3.5 - 3.74", "3.75 - 4", "4+"];
  assert.equal(pick("What is your GPA?", gpaOptions), "3.5 - 3.74");
  assert.equal(
    pick("What is your GPA?", gpaOptions, withGPA(answering, "4.0")),
    "3.75 - 4",
  );
  assert.equal(
    pick("What is your GPA?", gpaOptions, withGPA(answering, "1.9")),
    "Below 2",
  );
  const internships = ["None", "1", "2", "3", "3+"];
  const label =
    "How many prior internship(s) and/or co-op(s) have you completed in software engineering?";
  assert.equal(pick(label, internships), "None");
  assert.equal(pick(label, internships, { ...answering, internshipCount: "3" }), "3");
  assert.equal(pick(label, internships, { ...answering, internshipCount: "5" }), "3+");
  assert.equal(
    pick("Pronoun", ["He/Him/His", "She/Her/Hers", "He/They", "Other"]),
    "He/Him/His",
  );
  assert.equal(
    pick("Sexual Orientation", ["Straight", "Gay", "Bi-Sexual", "I don't wish to answer"]),
    "Straight",
  );
  assert.equal(
    pick(
      "Sexual Orientation",
      ["Heterosexual", "Bi-Sexual", "I don't wish to answer"],
      { ...answering, sexualOrientation: "Decline" },
    ),
    "I don't wish to answer",
  );
  assert.equal(
    pick(
      "Sexual Orientation",
      ["Heterosexual", "Bi-Sexual"],
      { ...answering, sexualOrientation: "bi" },
    ),
    "Bi-Sexual",
  );
  // A range list is a four-point one: a GPA on another scale is left.
  assert.equal(pick("What is your GPA?", gpaOptions, withGPA(answering, "8.7", "10")), undefined);
  // Free-text questions get the number itself; blanks are left for the user.
  assert.equal(proposals([field("GPA")], answering)[0]?.value, "3.62");
  assert.equal(proposals([field("GPA (out of 10)")], answering)[0]?.value, undefined);
  assert.equal(proposals([field("CGPA out of 10")], withGPA(answering, "8.7", "10"))[0]?.value, "8.7");
  assert.equal(proposals([field("Pronouns")], profile).length, 0);
  // The dropdown hint travels with the proposal when options load later.
  assert.deepEqual(
    proposals([field("What is your GPA?", { kind: "combobox" })], answering)[0],
    {
      fieldId: "fixture",
      value: "3.62",
      numeric: 3.62,
      scale: 4,
      question: "What is your GPA?",
      expectedValue: "",
      revision: 1,
      source: "confirmed-profile",
    },
  );
});

// Higher's Oracle form (check b2557878): "Cumulative GPA (Grading
// System)" is a list of its own, and "Cumulative GPA (Grade/Mark/GPA)" put
// 3.84 in the percentage band "Below 50" with the system left empty.
test("a GPA's grading system is chosen from the saved scale, and a band of another scale is never its grade", () => {
  const systems = ["Alphabetical (A+ to P)", "GPA (out of 100)/Percentage", "GPA/Grade (out of 12)", "GPA/Grade (out of 10)", "GPA/Grade (out of 5)", "GPA/Grade (out of 4)", "Other"];
  const system = (who: typeof profile) => proposals([field("Cumulative GPA (Grading System)", { kind: "radio", options: systems })], who)[0]?.value;
  const row = { organization: "Example State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2027-12", location: "", details: "" };
  const withRow = (extra: Record<string, string>) => profileSchema.parse({ ...profile, education: [{ ...row, ...extra }] });
  assert.equal(system(withRow({ gpa: "3.84", gpaScale: "4" })), "GPA/Grade (out of 4)");
  assert.equal(system(withRow({ gpa: "3.84" })), "GPA/Grade (out of 4)");
  assert.equal(system(withRow({ gpa: "8.7", gpaScale: "10" })), "GPA/Grade (out of 10)");
  assert.equal(system(withRow({ gpa: "85", gpaScale: "100" })), "GPA (out of 100)/Percentage");
  assert.equal(system(withRow({ gpa: "85", gpaScale: "other" })), undefined);
  assert.equal(system(withRow({})), undefined);
  // The grade: the percentage bands the list shows before a system is set
  // hold none of a four-point GPA; the four-point bands do.
  const who = withRow({ gpa: "3.84", gpaScale: "4" });
  const bands = ["Below 50", "50 - 59", "60 - 69", "70 - 79", "80 - 89", "90 - 100"];
  const four = ["Below 3.0", "3.0 - 3.49", "3.5 - 3.99", "4.0"];
  // Its options unread (a list read only once opened): the number travels
  // with the scale it is on, and the page's bands are judged by it.
  const unread = proposals([field("Cumulative GPA (Grade/Mark/GPA)", { kind: "combobox" })], who)[0]!;
  assert.equal(unread.scale, 4);
  assert.equal(pickListOption(unread, bands, (band) => band), undefined);
  assert.equal(pickListOption(unread, ["Below 5", "5 - 6.9"], (band) => band), undefined);
  assert.equal(pickListOption(unread, four, (band) => band), "3.5 - 3.99");
  // Its options read: no band of another scale is picked.
  const listed = (options: string[]) => proposals([field("Cumulative GPA (Grade/Mark/GPA)", { kind: "select", options })], who)[0]?.value;
  assert.notEqual(listed(bands), "Below 50");
  assert.equal(listed(four), "3.5 - 3.99");
});

test("profile rejects internship values that cannot be matched, and keeps each school's GPA as written", () => {
  assert.equal(profileSchema.safeParse({ ...profile, internshipCount: "two" }).success, false);
  // A grade on any scale is the applicant's to write ("8.7", "85", "1.3").
  for (const gpa of ["3.62", "8.7", "85", "1.3"])
    assert.equal(profileSchema.safeParse(withGPA(profile, gpa, "other")).success, true, gpa);
  // An older profile's one GPA moves to its latest school, on a four-point
  // scale when it fits one.
  const moved = profileSchema.parse({ ...profile, gpa: "3.6" });
  assert.equal(moved.education[0].gpa, "3.6");
  assert.equal(moved.education[0].gpaScale, "4");
  assert.equal("gpa" in moved, false);
});

// The single U.S. answers an older profile held, as today's entries.
const us = (who: typeof profile, workAuthorization: string, sponsorship = "") =>
  profileSchema.parse({ ...who, workAuthorization, sponsorship, citizenships: [] });
const withGPA = (who: typeof profile, gpa: string, gpaScale: "4" | "5" | "10" | "100" | "other" = "4") =>
  ({ ...who, education: who.education.map((row, index) => (index === 0 ? { ...row, gpa, gpaScale } : row)) });

// Oracle: "…do you currently hold or can you
// obtain valid US work authorization…" was taken for a sponsorship question
// (its "obtain … authorization"), and answered No to a Yes profile.
test("a question that asks whether the applicant may work, or can obtain that right, is work authorization", () => {
  const asked = "Are you legally authorized to work in the United States? In other words, do you currently hold or can you obtain valid US work authorization (e.g., currently hold H-1B status, or can commence employment based on F-1 Optional Practical Training (OPT))?";
  const answer = (who: typeof profile) => proposals([field(asked, { kind: "radio", options: ["Yes", "No"] })], who)[0]?.value;
  assert.equal(answer(us(profile, "Yes", "No")), "Yes");
  assert.equal(answer(us(profile, "No", "Yes")), "No");
  // Needing to obtain it is still sponsorship.
  assert.equal(proposals([field("Do you need to obtain work authorization?", { kind: "radio", options: ["Yes", "No"] })], us(profile, "Yes", "No"))[0]?.value, "No");
});

test("a list the site calls invalid over its own value is picked again from the answer", () => {
  const visa = "Please indicate your current visa type or basis for employment authorization in the United States: (e.g., N/A, E-1, F-1, Other). Please choose N/A if none of these apply to you.";
  const who = { ...profile, answers: [{ question: visa, answer: "N/A" }] };
  const typed = field(visa, { kind: "combobox", options: ["N/A", "E-1", "F-1", "Other"], value: "N/A", siteValue: true, invalid: true });
  assert.equal(proposals([typed], who)[0]?.value, "N/A");
  // A list the site accepts keeps its value.
  assert.deepEqual(proposals([{ ...typed, invalid: false }], who), []);
});

test("long school and program names reach a picker's short canonical names", () => {
  assert.deepEqual(
    nameVariants(
      "M.S. Data Science, Statistics & Engineering (Applied Systems)",
    ).slice(-3),
    ["Data Science", "Statistics", "Engineering"],
  );
  assert.ok(
    nameVariants("Pennsylvania State University, University Park").includes(
      "Pennsylvania State University",
    ),
  );
  assert.deepEqual(nameVariants("Computer Science"), []);
  const educated = profileSchema.parse({
    ...profile,
    education: [
      {
        organization: "Pennsylvania State University, University Park",
        title: "Bachelors of Science",
        fieldOfStudy: "M.S. Data Science, Statistics & Engineering (Applied Systems)",
        startDate: "2020-09",
        endDate: "2027-05",
      },
    ],
  });
  const pick = (label: string, options: string[]) =>
    proposals(
      [field(label, { kind: "select", options, section: "Education", index: 0 })],
      educated,
    )[0]?.value;
  // Punctuation differs from the picker's wording; the name is the same.
  assert.equal(
    pick("School", ["Pennsylvania State University - University Park", "Pennsylvania State University - Penn State Harrisburg"]),
    "Pennsylvania State University - University Park",
  );
  assert.equal(pick("Discipline", ["Computer Science", "Data Science"]), "Data Science");
  assert.equal(
    proposals(
      [field("What is your anticipated graduation month/year?", { kind: "select", options: ["December 2026", "May 2027", "Other"] })],
      educated,
    )[0]?.value,
    "May 2027",
  );
  assert.equal(
    proposals([field("Expected graduation year")], educated)[0]?.value,
    "2027",
  );
  // An ongoing program without an end date is left to the applicant.
  assert.equal(
    proposals([field("What is your anticipated graduation month/year?", { kind: "combobox" })], profileSchema.parse({ ...educated, education: [{ ...educated.education[0], endDate: "" }] })).length,
    0,
  );
});

test("project-link questions get the profile's GitHub or website as a full URL", () => {
  const linked = profileSchema.parse({
    ...profile,
    github: "github.com/alex-rivera",
    website: "alexrivera.dev",
    linkedin: "linkedin.com/in/alex-rivera",
  });
  const answer = (label: string) => proposals([field(label, { required: false })], linked)[0]?.value;
  assert.equal(
    answer("We encourage you to share a link that showcases something you've built and shipped yourself."),
    "https://github.com/alex-rivera",
  );
  assert.equal(answer("Portfolio URL"), "https://alexrivera.dev");
  assert.equal(answer("LinkedIn Profile"), "https://linkedin.com/in/alex-rivera");
  // Named GitHub, it gets the GitHub link, "or portfolio" notwithstanding.
  assert.equal(answer("Please leave your GitHub or portfolio link if you have one:"), "https://github.com/alex-rivera");
  // Already-complete links are kept as saved.
  assert.equal(
    proposals([field("GitHub")], { ...linked, github: "https://github.com/x" })[0]?.value,
    "https://github.com/x",
  );
  // No link in the profile: the question is left to the applicant.
  assert.equal(
    proposals([field("Share a link to a project you built")], { ...linked, github: "", website: "" }).length,
    0,
  );
});

test("parser-filled education rows follow profile order; entries of the applicant's own pair by school", () => {
  const educated = profileSchema.parse({
    ...profile,
    education: [
      { organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2027-05" },
      { organization: "Test Polytechnic", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2020-09", endDate: "2024-06" },
    ],
  });
  const row = (index: number, label: string, value = "", siteValue = false) =>
    field(label, { id: `${index}-${label}`, section: "Education", index, value, siteValue, required: true });
  // As a resume parser left them: row 0 holds the second school's major,
  // row 1 holds the first school's name.
  const fields = [
    row(0, "School"),
    row(0, "Major", "Computer Science", true),
    row(0, "Start date year"),
    row(1, "School", "Michigan state university", true),
    row(1, "Major"),
    row(1, "Start date year", "1999", true),
  ];
  const plan = (list: typeof fields) =>
    Object.fromEntries(
      proposals(list, educated).map((proposal) => [proposal.fieldId, proposal.value]),
    );
  // The parser's guesses decide nothing: rows follow the profile's order,
  // and wrong guesses are replaced.
  assert.deepEqual(plan(fields), {
    "0-School": "Michigan State University",
    "0-Major": "Data Science",
    "0-Start date year": "2025",
    "1-School": "Test Polytechnic",
    "1-Major": "Computer Science",
    "1-Start date year": "2020",
  });
  // A school the applicant entered themselves does pair its row.
  const entered = fields.map((field) =>
    field.id === "1-School" ? { ...field, siteValue: false } : field,
  );
  // (Row 0's parsed major is already right for that school, so it stays.)
  assert.deepEqual(plan(entered), {
    "0-School": "Test Polytechnic",
    "0-Start date year": "2020",
    "1-Major": "Data Science",
    "1-Start date year": "2025",
  });
  // Without the site flag, an existing value is never replaced.
  assert.equal(
    proposals([row(1, "Start date year", "1999")], educated).length,
    0,
  );
});

test("\"I have a preferred name\" follows a preferred name that differs from the first (reports ae4caa18, e15f54e1)", () => {
  const box = (value = "", siteValue = false) => field("I have a preferred name", { kind: "checkbox", options: [], required: false, value, siteValue });
  const named = (preferredName: string) => ({ ...profile, firstName: "Alex", preferredName });
  assert.equal(deterministicAnswer(box(), named("Alex")), "No");
  assert.equal(deterministicAnswer(box(), named("")), "No");
  assert.equal(deterministicAnswer(box(), named("Lex")), "Yes");
  // Ticked, by the fill or the site, for a name that is the first name: unticked.
  assert.equal(proposals([box("Yes", true)], named("alex"))[0]?.value, "No");
  assert.deepEqual(proposals([box()], named("Alex")), []);
});

test("a language skills checklist is ticked for each language the profile lists (report 1921049f)", () => {
  const speaker = profileSchema.parse({ ...profile, languages: ["English: Native", "Spanish: Basic"] });
  const box = (language: string) => field(`Language Skill(s) (Check all that apply): ${language}`, { id: language, kind: "checkbox", question: "Language Skill(s) (Check all that apply)", options: ["Yes", "No"], required: false });
  const value = (language: string) => proposals([box(language)], speaker)[0]?.value;
  assert.equal(value("English (ENG)"), "Yes");
  assert.equal(value("Spanish (SPA)"), "Yes");
  // A box for a language the profile does not list stays clear (No on a clear box writes nothing).
  assert.equal(value("French (FRA)"), undefined);
  assert.equal(value("American Sign Language (ASL)"), undefined);
});

test("a technology checklist ticks each option naming a profile skill and leaves the rest", () => {
  const coder = profileSchema.parse({ ...profile, skills: ["Python", "C", "ASP.NET", "html", "SQL"] });
  const question = "What technology stack do you have work/school experience with?";
  const options = ["C#", "C, C++", "React", "Python", "Azure", "SQL", "HTML/CSS", ".Net", "GraphQL"];
  const boxes = options.map((option) => field(`${question}: ${option}`, { id: option, kind: "checkbox", question, options: [], required: true }));
  const out = new Map(proposals(boxes, coder).map((proposal) => [proposal.fieldId, proposal.value]));
  for (const yes of ["C, C++", "Python", "SQL", "HTML/CSS", ".Net"]) assert.equal(out.get(yes), "Yes", yes);
  for (const no of ["C#", "React", "Azure", "GraphQL"]) assert.notEqual(out.get(no), "Yes", no);
  // No option names a skill: left to the existing flow.
  const none = profileSchema.parse({ ...profile, skills: ["Welding"] });
  assert.deepEqual(proposals(boxes, none), []);
});

test("a current-location list that words places \"City, ST\" gets the state's code (Meta, report 0b2dced5)", () => {
  const here = profileSchema.parse({ ...profile, city: "Flagstaff", state: "Arizona", country: "United States" });
  const proposal = proposals([field("Current location", { kind: "combobox", options: [], required: true })], here)[0];
  assert.equal(proposal?.value, "Flagstaff");
  assert.ok(proposal?.choices?.includes("Flagstaff, AZ"), JSON.stringify(proposal?.choices));
  assert.ok(proposal?.choices?.includes("Flagstaff, Arizona"));
});

test("\"How are you eligible to work in this location?\" is answered for a citizen of the job's country (Tailspin, report 4013480a)", () => {
  const options = ["I hold citizenship or permanent residency (No visa/sponsorship required)", "I hold a temporary work visa / permit that allows me to work full-time", "I do not currently have work authorization and will require visa sponsorship", "Other"];
  const ask = (who: typeof profile) => proposals([field("How are you eligible to work in this location?", { kind: "combobox", options })], who)[0]?.value;
  const citizen = { ...profile, workAuthorization: [{ country: "US", status: "citizen", needsSponsorship: false }] };
  assert.equal(ask(Object.assign(profileSchema.parse(citizen), { applyingTo: { country: "US", company: "Acme", title: "Intern" } })), options[0]);
  // Another country, or none known: left to the applicant.
  assert.equal(ask(Object.assign(profileSchema.parse(citizen), { applyingTo: { country: "GB", company: "Acme", title: "Intern" } })), undefined);
  assert.equal(ask(profileSchema.parse(citizen)), undefined);
});

test("an age asked as \"What's your age?\" is a band from the date of birth, and a gender-at-birth question follows the saved answer (Tailspin, report c98e802a)", () => {
  const born = profileSchema.parse({ ...profile, dateOfBirth: `${new Date().getFullYear() - 24}-01-01`, transgender: "No" });
  const bands = ["I prefer not to answer", "Under 21", "21-25", "26-34", "35-44"];
  assert.equal(proposals([field("What's your age?", { kind: "combobox", options: bands })], born)[0]?.value, "21-25");
  const birth = "Do you identify with a gender that is different to the gender assigned to you at birth?";
  assert.equal(proposals([field(birth, { kind: "combobox", options: ["I prefer not to answer", "Yes", "No"] })], born)[0]?.value, "No");
  // Nothing saved: left alone.
  assert.equal(proposals([field(birth, { kind: "combobox", options: ["I prefer not to answer", "Yes", "No"] })], profileSchema.parse({ ...profile, transgender: "" }))[0]?.value, undefined);
});

test("a web address box gets its scheme (Oracle's Work and Education History Link, 2026-11-12)", () => {
  const linked = profileSchema.parse({ ...profile, linkedin: "linkedin.com/in/alex-rivera" });
  const ask = (kind: string, label = "Work and Education History Link 1") => proposals([field(label, { kind, required: false })], linked)[0]?.value;
  assert.equal(ask("url", "LinkedIn Profile"), "https://linkedin.com/in/alex-rivera");
  // One that already has a scheme is untouched.
  assert.equal(proposals([field("LinkedIn Profile", { kind: "url", required: false })], profileSchema.parse({ ...profile, linkedin: "https://www.linkedin.com/in/alex-rivera" }))[0]?.value, "https://www.linkedin.com/in/alex-rivera");
});

test("a high school diploma question is Yes for an applicant with a finished degree (wingtip, 2026-11-12)", () => {
  const label = "Have you obtained a High School Diploma, Secondary School Certificate, or equivalent (GED, etc.)?";
  const ask = (who: typeof profile) => proposals([field(label, { kind: "radio", options: ["Yes", "No"] })], who)[0]?.value;
  const row = (endDate: string) => ({ organization: "Penn State", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2000-09", endDate });
  assert.equal(ask(profileSchema.parse({ ...profile, education: [row("2001-06")] })), "Yes");
  // Worded as iCIMS words it (international's form).
  assert.equal(proposals([field("Do you have a minimum of High School Diploma or GED?", { kind: "radio", options: ["Yes", "No"] })], profileSchema.parse({ ...profile, education: [row("2001-06")] }))[0]?.value, "Yes");
  assert.equal(ask(profileSchema.parse({ ...profile, education: [row("2099-06")] })), undefined);
  assert.equal(ask(profileSchema.parse({ ...profile, education: [] })), undefined);
});

test("a completion date split in three lists, named without a colon, takes one part each (Oracle, eihu 2026-11-12)", () => {
  const studying = profileSchema.parse({ ...profile, education: [{ organization: "Penn State", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2099-05" }] });
  const part = (name: string) => proposals([field(`Projected Completion Date ${name}`, { kind: "combobox", options: [], required: true, section: "Education", index: 0 })], studying)[0]?.value;
  assert.equal(part("Month"), "May");
  assert.equal(part("Year"), "2099");
});

test("a work-authorization question that names OPT as an example is Yes for a citizen, not No (Oracle, report ac3f1218)", () => {
  const label = "Are you legally authorized to work in the United States? In other words, do you currently hold or can you obtain valid US work authorization (e.g., currently hold H-1B status, or can commence employment based on F-1 Optional Practical Training (OPT))?";
  const citizen = Object.assign(profileSchema.parse({ ...profile, workAuthorization: [{ country: "US", status: "citizen", needsSponsorship: false }] }), { applyingTo: { country: "US", company: "Acme", title: "Intern" } });
  assert.equal(proposals([field(label, { kind: "radio", options: ["Yes", "No"] })], citizen)[0]?.value, "Yes");
  // The question that really asks about temporary authorization is still No.
  assert.equal(proposals([field("Do you have temporary work authorization (e.g., OPT, CPT)?", { kind: "radio", options: ["Yes", "No"] })], citizen)[0]?.value, "No");
});

test("a web address box holding an address the site calls invalid for want of a scheme is given one (Oracle's wingtip link, 2026-11-12)", () => {
  const box = (value: string, invalid: boolean) => field("Work and Education History Link 1", { kind: "url", required: false, value, invalid });
  assert.equal(proposals([box("linkedin.com/in/alex-rivera", true)], profile)[0]?.value, "https://linkedin.com/in/alex-rivera");
  // Accepted, or with a scheme already: left alone.
  assert.deepEqual(proposals([box("linkedin.com/in/alex-rivera", false)], profile).filter((p) => p.value.startsWith("https://linkedin")), []);
  assert.deepEqual(proposals([box("https://linkedin.com/in/alex-rivera", true)], profile).filter((p) => p.value === "https://https://linkedin.com/in/alex-rivera"), []);
});

test("a bare Language list takes the language the applicant knows best (Oracle's wingtip form, 2026-11-12)", () => {
  const speaker = profileSchema.parse({ ...profile, languages: ["Spanish: Basic", "English: Native"] });
  const ask = (who: typeof profile) => proposals([field("Language", { kind: "combobox", options: [], required: true })], who)[0]?.value;
  assert.equal(ask(speaker), "English");
  // A list that names each language by country gets the applicant's own.
  const proposal = proposals([field("Language", { kind: "combobox", options: [], required: true })], profileSchema.parse({ ...speaker, country: "United States" }))[0];
  assert.ok(proposal?.choices?.includes("English (United States)"), JSON.stringify(proposal?.choices));
  assert.equal(ask(profileSchema.parse({ ...profile, languages: [] })), undefined);
});

test("a School list that names each school with its state is given that wording (Oracle's higher form, 2026-11-12)", () => {
  const studied = profileSchema.parse({ ...profile, education: [{ organization: "Penn State University", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2020-09", endDate: "2024-06", location: "University Park, PA" }] });
  const proposal = proposals([field("School", { kind: "combobox", options: [], required: true, section: "Education", index: 0 })], studied)[0];
  assert.ok(proposal?.choices?.includes("Penn State University - Pennsylvania"), JSON.stringify(proposal?.choices));
  assert.ok(proposal?.choices?.includes("Penn State University - PA"));
});

test("education rows that share a field of study are not paired by it (Workday, report 18cb61e8)", () => {
  // The fill gave both schools "Computer Science", the closest field the
  // site listed for the first. That shared value is the second school's, and
  // it paired the first page row with it, swapping the two schools.
  const educated = profileSchema.parse({
    ...profile,
    education: [
      { organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "Data Science, Analytics & Engineering", startDate: "2025-08", endDate: "2027-05" },
      { organization: "Test Polytechnic", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2020-09", endDate: "2024-06" },
    ],
  });
  const row = (index: number, label: string, value = "") =>
    field(label, { id: `${index}-${label}`, section: "Education", index, value, required: true });
  const fields = [
    row(0, "School or University"),
    row(0, "Field of Study", "Computer Science"),
    row(1, "School or University"),
    row(1, "Field of Study", "Computer Science"),
  ];
  const plan = Object.fromEntries(proposals(fields, educated).map((proposal) => [proposal.fieldId, proposal.value]));
  assert.equal(plan["0-School or University"], "Michigan State University");
  assert.equal(plan["1-School or University"], "Test Polytechnic");
});

test("work authorization and sponsorship choices come from the profile, in either wording", () => {
  const applicant = profileSchema.parse({ ...profile, workAuthorization: "Yes", sponsorship: "No" });
  const yesNo = ["Yes", "No"];
  const pick = (label: string, options = yesNo, kind = "radio", who = applicant) =>
    proposals([field(label, { kind, options })], who)[0]?.value;
  // Lever custom-question wording from the eval corpus.
  assert.equal(pick("Are you authorized to work in the United States?"), "Yes");
  assert.equal(pick("Are you lawfully authorized to work in the United States?"), "Yes");
  assert.equal(pick("Do you require sponsorship now or in the future to work at Neighbor?"), "No");
  assert.equal(pick("Will you require sponsorship for employment now or in the future?", yesNo, "select"), "No");
  assert.equal(pick("Will you now or in the future require sponsorship for work authorization?"), "No");
  assert.equal(pick("Do you currently require immigration sponsorship for work authorization? "), "No");
  // Asking for authorization is asking for sponsorship.
  assert.equal(pick("Do you require work authorization to work in the U.S.?"), "No");
  // "Without sponsorship" asks the opposite question.
  assert.equal(pick("Are you legally able to work in the US without sponsorship?"), "Yes");
  assert.equal(pick("Are you legally able to work in the US without sponsorship?", yesNo, "radio", us(applicant, "Yes", "Yes")), "No");
  // A citizenship answer in the profile still reads as authorized.
  assert.equal(pick("Are you authorized to work in the United States?", yesNo, "radio", us(applicant, "U.S. citizen", "No")), "Yes");
  // Left to the applicant: another country, two questions in one, free text,
  // an empty profile field, and options that aren't a yes/no.
  assert.equal(pick("Are you legally entitled to work in Canada?"), undefined);
  assert.equal(pick("Are you legally authorized to work in Canada (e.g., citizen or permanent resident)?"), undefined);
  assert.equal(pick("Are you authorized to work in the US, and will you require sponsorship?"), undefined);
  assert.equal(pick("If you require sponsorship, please explain", [], "textarea"), undefined);
  assert.equal(pick("Are you authorized to work in the United States?", yesNo, "radio", us(applicant, "", "No")), undefined);
  assert.equal(pick("Are you authorized to work in the United States?", ["US Citizen", "Green Card", "H-1B"]), undefined);
});

test("unloaded remote screening menus receive confirmed binary answers without guessing status or jurisdiction", () => {
  const applicant = profileSchema.parse({ ...profile, workAuthorization: "Yes", sponsorship: "No" });
  const ask = (label: string, who = applicant, kind = "combobox") => proposals([field(label, { kind })], who)[0]?.value;
  assert.equal(ask("Will you require sponsorship for employment visa status in the United States?"), "No");
  assert.equal(ask("Are you authorized to work in the United States?"), "Yes");
  assert.equal(ask("Are you able to work in the US without sponsorship?"), "Yes");
  assert.equal(ask("Are you authorized to work in Canada?"), undefined);
  assert.equal(ask("Are you authorized to work in the country where this role is based?"), undefined);
  assert.equal(ask("Do you have temporary work authorization in the United States?"), undefined);
  assert.equal(ask("Can you provide proof that you are authorized to work in the United States?"), undefined);
  assert.equal(ask("Are you authorized to work in the US, and will you require sponsorship?"), undefined);
  assert.equal(ask("If you require sponsorship, please explain", applicant, "textarea"), undefined);
  assert.equal(ask("Are you authorized to work in the United States?", us(applicant, "", "No")), undefined);
});

test("an address block's Jurisdiction/Country list gets the profile's country", () => {
  const options = ["Afghanistan", "Canada", "United States", "Zambia"];
  assert.equal(proposals([field("Jurisdiction/Country", { kind: "select", options })], { ...profile, country: "United States" })[0]?.value, "United States");
});

test("demographic choices come from the profile, matched to each portal's option wording", () => {
  const applicant = profileSchema.parse({
    ...profile,
    gender: "Female",
    hispanic: "No",
    ethnicity: "White",
    veteranStatus: "I am not a protected veteran",
    disabilityStatus: "No",
  });
  const pick = (label: string, options: string[], who = applicant) =>
    proposals([field(label, { kind: "radio", options })], who)[0]?.value;
  // Ashby's EEO options, as captured.
  const race = [
    "Hispanic or Latino",
    "White (Not Hispanic or Latino)",
    "Black or African American (Not Hispanic or Latino)",
    "Asian (Not Hispanic or Latino)",
    "Two or More Races (Not Hispanic or Latino)",
    "Decline to self-identify",
  ];
  assert.equal(pick("Gender", ["Male", "Female", "Decline to self-identify"]), "Female");
  assert.equal(pick("Race", race), "White (Not Hispanic or Latino)");
  assert.equal(pick("Are you Hispanic/Latino?", ["Yes", "No", "Decline to self-identify"]), "No");
  const veteran = [
    "I identify as one or more of the classifications of protected veteran listed above",
    "I am not a protected veteran",
    "I decline to self-identify for protected veteran status",
  ];
  assert.equal(pick("Veteran Status", veteran), "I am not a protected veteran");
  assert.equal(pick("Veteran Status", veteran, { ...applicant, veteranStatus: "Yes" }), veteran[0]);
  // PageUp's VEVRAA question (issue report) says only "veterans",
  // and its decline is spelled with a Unicode hyphen.
  const vevraa =
    "If you believe you belong to any of the categories of protected veterans listed above, please indicate by checking the appropriate box below. As a Government contractor subject to VEVRAA, we request this information.";
  const vevraaOptions = [veteran[0] + ".", veteran[1] + ".", "I choose not to self‐identify."];
  for (const [veteranStatus, index] of [["Yes", 0], ["No", 1], ["Decline", 2]] as const)
    assert.equal(pick(vevraa, vevraaOptions, { ...applicant, veteranStatus }), vevraaOptions[index], veteranStatus);
  // iCIMS's veteran radios are labelled by the whole VEVRAA notice, which
  // names the "Vietnam Era Veterans' Readjustment Assistance Act": a U.S.
  // law, not another country's question (a report).
  const notice =
    "Why are you being asked to complete this form? 1. This employer is a Government contractor subject to the Vietnam Era Veterans' Readjustment Assistance Act of 1974, as amended by the Jobs for Veterans Act of 2002, 38 U.S.C. 4212 (VEVRAA).";
  const upper = ["I IDENTIFY AS ONE OR MORE OF THE CLASSIFICATIONS OF PROTECTED VETERAN LISTED ABOVE", "I AM NOT A PROTECTED VETERAN", "I DON'T WISH TO ANSWER"];
  assert.equal(pick(notice, upper, { ...applicant, veteranStatus: "I am not a veteran" }), upper[1]);
  // The OFCCP disability form; its decline option must not read as "No".
  const disability = [
    "Yes, I have a disability (or previously had a disability)",
    "No, I do not have a disability and have not had one in the past",
    "I do not want to answer",
  ];
  assert.equal(pick("Disability Status", disability), disability[1]);
  assert.equal(pick("Disability Status", disability, { ...applicant, disabilityStatus: "Decline" }), "I do not want to answer");
  // PageUp's copy of the form (issue report) asks only "Please
  // check one of the boxes below:"; its options say what is being asked.
  const boxes = "Please check one of the boxes below:";
  const pageUp = [disability[0], "No, I don't have a disability", "I don't wish to answer"];
  for (const [disabilityStatus, index] of [["Yes", 0], ["No", 1], ["Decline", 2]] as const)
    assert.equal(pick(boxes, pageUp, { ...applicant, disabilityStatus }), pageUp[index], disabilityStatus);
  // Jobvite's veteran form asks only "Choose One"; its options say what is
  // being asked.
  const chooseOne = [
    "I IDENTIFY AS ONE OR MORE OF THE CLASSIFICATIONS OF PROTECTED VETERAN LISTED ABOVE.",
    "I AM NOT A PROTECTED VETERAN",
    "DECLINE SELF-IDENTIFICATION",
  ];
  for (const [veteranStatus, index] of [["Yes", 0], ["No", 1], ["Decline", 2]] as const)
    assert.equal(pick("Choose One", chooseOne, { ...applicant, veteranStatus }), chooseOne[index], veteranStatus);
  // One option mentioning a disability does not make the question about it.
  assert.equal(pick(boxes, ["I have a disability", "I am a veteran", "None of these"]), undefined);
  // Declines find each portal's own decline wording.
  const decliner =profileSchema.parse({ ...applicant, gender: "I do not wish to answer", ethnicity: "Decline" });
  assert.equal(pick("Gender", ["Male", "Female", "Decline to self-identify"], decliner), "Decline to self-identify");
  assert.equal(pick("Race", race, decliner), "Decline to self-identify");
  // A "decline" that also states a group is not a decline (UK-style lists).
  const ukEthnicity = [
    "White",
    "Mixed or multiple ethnic groups",
    "Other ethnic group (Arab; Any other ethnic group; Prefer not to say)",
  ];
  assert.equal(pick("Ethnicity", ukEthnicity, decliner), undefined);
  assert.equal(pick("Ethnicity", ["Asian", "Other ethnic group (Prefer not to say or self-describe)"], decliner), undefined);
  // A decline that only repeats the question's words still counts.
  assert.equal(pick("Veteran Status", veteran, { ...applicant, veteranStatus: "Decline" }), veteran[2]);
  // Groups listed with their definitions (PageUp, issue report):
  // a definition names other groups' places, and is not what the option says.
  const defined = [
    "Hispanic or Latino A person of Cuban, Mexican, Puerto Rican, South or Central American, or other Spanish culture or origin, regardless of race.",
    "White (Not Hispanic or Latino) A person having origins in any of the original peoples of Europe, the Middle East, or North Africa.",
    "American Indian or Alaska Native (Not Hispanic or Latino) A person having origins in any of the original peoples of North and South America (including Central America), and who maintains tribal affiliation or community attachment.",
    "Black or African American (Not Hispanic or Latino) A person having origins in any of the black racial groups of Africa.",
    "Native Hawaiian or Other Pacific Islander (Not Hispanic or Latino) A person having origins in any of the peoples of Hawaii, Guam, Samoa, or other Pacific Islands.",
    "Asian (Not Hispanic or Latino) A person having origins in any of the original peoples of the Far East, Southeast Asia, or the Indian Subcontinent, including, for example, Cambodia, China, India, Japan, Korea, Malaysia, Pakistan, the Philippine Islands, Thailand, and Vietnam.",
    "Two or More Races (Not Hispanic or Latino) All persons who identify with more than one of the above races, excluding those who identify themselves as Hispanic or Latino.",
    "Not Disclosed",
  ];
  const question = "Race/Ethnicity Category* Please select the option that describes the race/ethnicity category with which you primarily identify.";
  for (const [ethnicity, index] of [
    ["Hispanic/Latinx", 0],
    ["White", 1],
    ["Native American", 2],
    ["African American", 3],
    ["Pacific Islander", 4],
    ["East Asian", 5],
    ["South Asian", 5],
    ["Southeast Asian", 5],
    ["Two or More", 6],
    ["Decline", 7],
  ] as const)
    assert.equal(pick(question, defined, profileSchema.parse({ ...applicant, ethnicity })), defined[index], ethnicity);
  // A plain "Asian" answers for any Asian group, unless the list names them.
  assert.equal(pick("Race", ["South Asian", "East Asian", "Asian"], profileSchema.parse({ ...applicant, ethnicity: "South Asian" })), "South Asian");
  assert.equal(pick("Race", ["East Asian", "White"], profileSchema.parse({ ...applicant, ethnicity: "South Asian" })), undefined);
  // No guessing: an answer the options don't state, or no answer at all.
  assert.equal(pick("Race", ["Asian", "Black", "Other"]), undefined);
  assert.equal(pick("Gender", ["Male", "Female"], profileSchema.parse({ ...applicant, gender: "" })), undefined);
});

// Bank of America / TalNet: a previous degree must not be
// denied when both current and previous education are in the profile.
test("previous university education is confirmed by multiple education entries", () => {
  const question = field("Do you have any previous university education?", {
    kind: "select", options: ["Yes", "No"], value: "no", siteValue: true,
  });
  const graduate = profileSchema.parse({ ...profile, education: [
    { organization: "Example Graduate University", title: "Master of Science", startDate: "2025-08", endDate: "2099-05" },
    { organization: "Example Undergraduate College", title: "Bachelor of Science", startDate: "2020-09", endDate: "2024-06" },
  ] });
  assert.equal(proposals([question], graduate)[0]?.value, "Yes");
  assert.equal(deterministicAnswer({ ...question, section: "Current University Education" }, graduate), "Yes");
  // A single saved row does not establish that there was no earlier study.
  assert.equal(deterministicAnswer(question, profile), undefined);
  assert.deepEqual(proposals([{ ...question, protected: true }], graduate), []);
  assert.deepEqual(proposals([{ ...question, siteValue: false }], graduate), []);
  assert.equal(deterministicAnswer(question, profileSchema.parse({ ...graduate,
    answers: [{ question: question.label, answer: "No" }],
  })), "No");
});

// Greenhouse (an employer, task e90ed1a9): the export-control
// question lists the kinds of U.S. person instead of Yes and No. The
// applicant's citizenship is in the profile's export-control statement, not
// in a saved answer, and the question was left empty.
test("a citizen's export-control statement picks the citizen from a list of U.S. person statuses", () => {
  const statuses = [
    "A United States citizen or national",
    "A person lawfully admitted for permanent residence of the United States (i.e., “Green Card” holder)",
    "A person admitted as a refugee to the United States under 8 U.S.C. 1157",
    "A person admitted as an asylee to the United States under 8 U.S.C. 1158",
    "None of the above",
  ];
  const label = "EXPORT CONTROLS - This position requires access to information and technology that is subject to U.S. export controls. Your responses to the questions below will be used solely to determine your eligibility under U.S. law to receive information and materials subject to U.S. export controls.";
  const legal = (exportControl: string) => profileSchema.parse({ ...profile, answers: [], legal: { ...profile.legal, exportControl } });
  const pick = (who: ReturnType<typeof legal>, options = statuses) => {
    const answer = proposals([field(label, { kind: "select", options })], who)[0];
    return answer && pickListOption(answer, options, (option) => option);
  };
  assert.equal(pick(legal("U.S. citizen (a U.S. person under ITAR and EAR)")), "A United States citizen or national");
  // A U.S. person who is not a citizen could be any of the others.
  assert.equal(pick(legal("U.S. person (permanent resident)")), undefined);
  assert.equal(pick(legal("Not a U.S. person")), undefined);
  assert.equal(pick(legal("")), undefined);
  // A Yes/No version takes Yes from the statement.
  assert.equal(pick(legal("U.S. person (permanent resident)"), ["Yes", "No"]), "Yes");
  // one employer's words a citizen "A citizen of the U.S.".
  assert.equal(pick(legal("U.S. citizen (a U.S. person under ITAR and EAR)"), ["A citizen of the U.S.", "A lawful permanent resident of the U.S.", "None of the above"]), "A citizen of the U.S.");
  // Citizenship of an embargoed country is another question, the applicant's
  // to answer: it got "Yes".
  const embargo = "All Acme sites must observe U.S. export control rules that control information that may be provided to persons from Cuba, Iran, North Korea, and Syria. Are you a citizen of, or do you hold dual citizenship with any of these countries?";
  assert.deepEqual(proposals([field(embargo, { kind: "combobox", options: [] })], legal("U.S. citizen (a U.S. person under ITAR and EAR)")), []);
});

// Amazon.jobs opens several export-control
// questions with the same notice. The applicant's full legal name, the
// denied-persons question (its "Arms Export Control Act" list) and the dual
// citizenship box were each answered Yes as if they asked about U.S. person
// status.
test("an export-control notice before another question does not make it the U.S. person question", () => {
  const notice = "Amazon collects this information solely for the purpose of complying with United States export control laws and regulations.";
  const citizen = profileSchema.parse({
    ...profile,
    answers: [{ question: "Are you a U.S. person under export control regulations?", answer: "Yes" }],
    legal: { ...profile.legal, exportControl: "U.S. citizen (a U.S. person under ITAR and EAR)" },
  });
  const answer = (label: string, overrides: Partial<Field> = {}) => proposals([field(label, overrides)], citizen)[0]?.value;
  assert.notEqual(answer(`${notice} What is your full legal name:`), "Yes");
  assert.notEqual(answer(`${notice} If you have dual citizenship, please identify the last country in which you obtained citizenship, or type, I do not have dual citizenship.`), "Yes");
  assert.notEqual(
    answer(
      `${notice} Are you currently, or have you ever been at any time, any of the following: (1) a person designated on the Denied Persons List, which is enforced by the Department of Commerce’s Bureau of Industry and Security, (2) a person designated on the Arms Export Control Act Debarred List, which is enforced by the Department of State’s Directorate of Defense Trade Controls, or (3) debarred or prohibited from contracting with or engaging in any dealing with the U.S. government or any other governmental entity?`,
      { kind: "select", options: ["Yes", "No"] },
    ),
    "Yes",
  );
  // The status question itself, and a notice that is the whole label, still are.
  assert.equal(answer(`${notice} Are you a U.S. person under export control regulations?`, { kind: "select", options: ["Yes", "No"] }), "Yes");
  assert.equal(answer(notice, { kind: "select", options: ["Yes", "No"] }), "Yes");
});

test("a saved answer covers the same standing question in other words, and no other", () => {
  const saved = profileSchema.parse({
    ...profile,
    willingToRelocate: "Yes",
    work: [{ organization: "Example Labs", title: "Intern", startDate: "2024-06", endDate: "2024-08", details: "", location: "" }],
    priorEmployment: "No",
    answers: [
      { question: "What are your salary expectations?", answer: "$100,000/year" },
      { question: "Do you hold an active security clearance?", answer: "No" },
      { question: "Are you a U.S. citizen?", answer: "Yes" },
      { question: "When can you start?", answer: "Immediately" },
      { question: "Are you willing to work onsite?", answer: "Yes" },
    ],
  });
  const value = (label: string, overrides: Partial<Field> = {}) => proposals([field(label, overrides)], saved)[0]?.value;
  // Other wordings of what was saved.
  assert.equal(value("Would you be open to relocation for this role?", { kind: "select", options: ["Yes", "No"] }), "Yes");
  assert.equal(value("Are you open to relocating?", { kind: "select", options: ["Yes, I am willing to relocate", "No, I am not"] }), "Yes, I am willing to relocate");
  assert.equal(value("Desired salary", { kind: "number" }), "100000");
  assert.equal(value("What is your expected compensation?"), "$100,000/year");
  assert.equal(value("Active Security Clearance(s)", { kind: "select", options: ["Secret", "Top Secret", "None"] }), "None");
  assert.equal(value("Citizenship Status", { kind: "select", options: ["U.S. Citizen", "Permanent Resident", "Other"] }), "U.S. Citizen");
  assert.equal(value("This position is subject to export control laws. Are you a U.S. person?", { kind: "select", options: ["Yes", "No"] }), undefined);
  assert.equal(value("This role requires being in the office 5 days a week. Are you able to meet this requirement?", { kind: "select", options: ["Yes", "No"] }), "Yes");
  // an employer: working from one of its offices on set days.
  assert.equal(value("We work from our offices on Mondays, Tuesdays, and Thursdays (Anchor Days). If you need an accommodation, we’ll partner with you and explore reasonable options consistent with applicable law. Are you able to commit to working from one of our offices on Anchor Days each week?", { kind: "radio", options: ["Yes", "No"] }), "Yes");
  assert.equal(value("What is your earliest start date?"), "Immediately");
  assert.equal(value("Have you previously worked at Acme?", { kind: "select", options: ["Yes", "No"] }), "No");
  // A box that takes only a date gets today's for "Immediately" (a report: Ashby's date picker dropped the word, and the applicant
  // entered the day themselves), in the box's own format.
  const today = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  assert.equal(value("Earliest start date", { kind: "date" }), `${today.getFullYear()}-${two(today.getMonth() + 1)}-${two(today.getDate())}`);
  assert.equal(value("When can you start a new role?", { kind: "datepicker" }), `${two(today.getMonth() + 1)}/${two(today.getDate())}/${today.getFullYear()}`);
  // A date split in three after its question (Bose's Workday questionnaire): each box takes its part of today's date, not the word.
  const part = (name: string) => proposals([field(`When are you available to start?: ${name}`, { kind: "spinbutton" })], saved)[0];
  assert.equal(part("Year")?.value, String(today.getFullYear()));
  assert.equal(part("Day")?.value, String(today.getDate()));
  assert.ok(["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][today.getMonth()] === part("Month")?.value);
  assert.equal(proposals([field("When are you available to start?: Year", { kind: "spinbutton" })], { ...saved, answers: [{ question: "When can you start?", answer: "Two weeks after an offer" }] })[0]?.value, undefined);
  assert.equal(
    proposals([field("When can you start a new role?", { kind: "datepicker" })], { ...saved, answers: [{ question: "When can you start?", answer: "Two weeks after an offer" }] })[0]?.value,
    undefined,
  );
  // A question naming one of the applicant's own employers is answered
  // from their work history: they did work there.
  assert.equal(value("Have you previously worked at Example Labs?", { kind: "select", options: ["Yes", "No"] }), "Yes");
  // Not the same question: another country, an answer the list does not
  // offer, or no topic at all.
  assert.equal(value("Are you willing to relocate to Canada?", { kind: "select", options: ["Yes", "No"] }), undefined);
  assert.equal(value("Desired salary", { kind: "select", options: ["Under $50,000", "$50,000 - $75,000"] }), undefined);
  assert.equal(value("Do you have a family member employed here?", { kind: "select", options: ["Yes", "No"] }), undefined);
  // An hourly rate is not the saved yearly figure, and a long preamble that
  // merely mentions a topic does not make the question about it.
  assert.equal(value("What are your hourly pay requirements", { kind: "number" }), undefined);
  assert.equal(value("Interns attend an on-site summit in Arlington and are able to join weekly sessions online. Which cohort are you applying to?", { kind: "select", options: ["Yes", "No"] }), undefined);
  assert.equal(value("This is an in-person role at our Lehi HQ. Are you able and willing to commute and/or relocate to Utah?", { kind: "select", options: ["Yes", "No"] }), "Yes");
  // "Either of these" is answered by a citizen, and weekday hours by
  // full-time availability.
  const more = profileSchema.parse({ ...saved, answers: [...saved.answers, { question: "Are you available to work full-time?", answer: "Yes" }] });
  const also = (label: string, who = more) => proposals([field(label, { kind: "radio", options: ["Yes", "No"] })], who)[0]?.value;
  assert.equal(also("Due to the regulatory environment of our industry, this role requires US Citizenship or Permanent Residence. Do you meet either of these criteria?"), "Yes");
  assert.equal(also("Summer internships are full-time. Are you available Monday–Friday, 8:00 AM–4:30 PM during the internship period?"), "Yes");
  const notCitizen = profileSchema.parse({ ...saved, answers: [{ question: "Are you a U.S. citizen?", answer: "No" }] });
  assert.equal(also("This role requires US Citizenship or Permanent Residence. Do you meet either of these criteria?", notCitizen), undefined);
  // Without a saved answer nothing is assumed.
  assert.equal(proposals([field("Desired salary", { kind: "number" })], profile).length, 0);
});

test("career preferences answer work arrangements and start dates ahead of reusable answers", () => {
  const saved = profileSchema.parse({
    ...profile,
    workArrangements: ["onsite", "hybrid"],
    availableFrom: "2099-07-16",
    answers: [
      { question: "Are you willing to work onsite?", answer: "No" },
      { question: "What is your earliest start date?", answer: "Immediately" },
    ],
  });
  const value = (label: string, overrides: Partial<Field> = {}, who = saved) => proposals([field(label, overrides)], who)[0]?.value;
  const choice = { kind: "select", options: ["Yes", "No"] };
  assert.equal(value("Are you willing to work onsite?", choice), "Yes");
  assert.equal(value("Are you comfortable with hybrid work?", choice), "Yes");
  assert.equal(value("Are you willing to work remotely?", choice), "No");
  assert.equal(value("Are you able to commute to our Boulder office?", choice), undefined);
  assert.equal(value("What is your earliest start date?", { kind: "date" }), "2099-07-16");
  assert.equal(value("When are you available to start?: Day", { kind: "spinbutton" }), "16");
  assert.equal(value("What is your earliest start date?", { kind: "date" }, { ...saved, availableFrom: "immediately" }), localDate());
  assert.equal(value("Start date", { kind: "date", section: "Employment history" }), undefined);
  assert.equal(value("What is your earliest start date?", { kind: "date" }, { ...saved, availableFrom: undefined }), localDate());
  const sources = fieldFallbackSources(saved);
  assert.match(sources.find(({ id }) => id === "profile.workArrangements")!.text, /onsite, hybrid/);
  assert.match(sources.find(({ id }) => id === "profile.availableFrom")!.text, /2099-07-16/);
  assert.ok(!sources.some(({ id }) => id.startsWith("answer.")));
});

test("a reusable coding assessment answer applies to equivalent willingness questions", () => {
  const saved = profileSchema.parse({
    ...profile,
    answers: [{ question: "Are you willing to complete a coding assessment?", answer: "Yes" }],
  });
  const value = (label: string) => proposals([field(label, { kind: "select", options: ["Yes", "No"] })], saved)[0]?.value;
  assert.equal(value("Would you take a coding test as part of the interview?"), "Yes");
  assert.equal(value("Have you already completed our coding assessment?"), undefined);
  assert.equal(value("Are you willing to take an online personality assessment?"), undefined);
});

test("a saved clearance answers current holding and a clearance-level list", () => {
  const saved = profileSchema.parse({
    ...profile,
    legal: { clearance: "No security clearance, and never held one" },
    answers: [{ question: "Do you hold an active security clearance?", answer: "Yes" }],
  });
  const value = (label: string, options = ["Yes", "No"]) => proposals([field(label, { kind: "select", options })], saved)[0]?.value;
  assert.equal(value("Do you hold an active security clearance?"), "No");
  assert.equal(value("What is your current security clearance level?", ["Secret", "Top Secret", "None"]), "None");
  assert.equal(value("Are you eligible to obtain a security clearance?"), undefined);
  assert.equal(value("Do you have any concerns about getting a security clearance?"), undefined);
  assert.equal(value("When did your last security clearance expire?", ["Last year", "Never"]), undefined);
});

test("acknowledgement boxes are ticked only with the profile's permission, and never a signature or an opt-in", () => {
  const allowed = profileSchema.parse({ ...profile, acknowledgeTerms: true });
  const ticked = (label: string, who = allowed) => proposals([field(label, { kind: "checkbox" })], who)[0]?.value;
  assert.equal(ticked("I agree to the Privacy Policy"), "Yes");
  assert.equal(ticked("I certify that the information above is true and complete"), "Yes");
  assert.equal(ticked("I acknowledge that I have read the applicant privacy notice"), "Yes");
  assert.equal(ticked("By checking this box I consent to the processing of my data"), "Yes");
  // Not without permission.
  assert.equal(ticked("I agree to the Privacy Policy", profile), undefined);
  // Never these, permission or not.
  assert.equal(ticked("Signature: I agree and sign electronically"), undefined);
  assert.equal(ticked("I do not agree"), undefined);
  assert.equal(ticked("I agree to receive SMS text messages about my application"), undefined);
  assert.equal(ticked("I consent to join the talent community for future opportunities"), undefined);
  assert.equal(ticked("Immuta has my consent to contact me about future job opportunities."), undefined);
  // And only boxes: a consent question with options is the applicant's.
  assert.equal(proposals([field("Do you consent to a background check?", { kind: "select", options: ["Yes", "No"] })], allowed).length, 0);
});

test("a screening question is read from what it asks, not from the instructions after it", () => {
  const applicant = profileSchema.parse({ ...profile, workAuthorization: "Yes", sponsorship: "No" });
  const label =
    'Do you now or will you in the future require sponsorship for employment visa status? Please select "Yes" if you will require the Company to commence ("sponsor") an immigration case in order to be authorized to work, or to continue to be authorized to work, in the United States.';
  assert.equal(proposals([field(label, { kind: "radio", options: ["Yes", "No"] })], applicant)[0]?.value, "No");
  // Two questions in one are still left to the applicant.
  assert.equal(proposals([field("Are you authorized to work in the U.S., and will you require sponsorship?", { kind: "radio", options: ["Yes", "No"] })], applicant).length, 0);
});

test("a school asked as a question picks the listed school, never Other", () => {
  const label = 'Which university are you currently attending or did you last attend? Please select "Other (School Not Listed)" if your school is not listed.';
  const pick = (options: string[]) => proposals([field(label, { kind: "select", options })], profile)[0]?.value;
  assert.equal(pick(["Aalborg University", "Test University", "Other (School Not Listed)"]), "Test University");
  assert.equal(pick(["Aalborg University", "Other (School Not Listed)"]), undefined);
  assert.equal(proposals([field("Which high school did you attend?", { kind: "select", options: ["Test University"] })], profile).length, 0);
});

test("an optional home phone beside a mobile one gets no proposal, empty or holding a number", () => {
  for (const value of ["", "+1 540 555 0100"]) {
    const found = proposals([field("Mobile Number", { id: "mobile", kind: "tel" }), field("Home Phone Number", { id: "home", kind: "tel", value })], profile);
    assert.ok(!found.some((p) => p.fieldId === "home"), value || "empty");
  }
});

test("a City/Town box takes the saved city", () => {
  for (const label of ["City/Town", "City / Town", "Town or City"]) assert.equal(deterministicAnswer(field(label), profile), profile.city, label);
});

test("a lone Street Name box takes the saved street address", () => {
  assert.equal(deterministicAnswer(field("Street Name"), profile), profile.address);
  assert.equal(deterministicAnswer(field("Street"), profile), profile.address);
});

test("a work-history row's address and reason for leaving come from that row only", () => {
  const worked = profileSchema.parse({
    ...profile,
    work: [{ organization: "Example Labs", title: "Intern", startDate: "2024-06", endDate: "2024-08", location: "Tucson, AZ", details: "", address: "1 Lab Way", postalCode: "48910", reasonForLeaving: "Internship ended" }],
  });
  const inWork = (label: string, who = worked) => deterministicAnswer(field(label, { section: "Work Experience 1", index: 0 }), who);
  assert.equal(inWork("Address Line 1"), "1 Lab Way");
  assert.equal(inWork("City"), "Tucson");
  assert.equal(inWork("State"), "AZ");
  assert.equal(inWork("Zip Code"), "48910");
  assert.equal(inWork("Reason for Leaving"), "Internship ended");
  // A row without them is not given the applicant's home address.
  const bare = profileSchema.parse({ ...profile, work: [{ organization: "Example Labs", title: "Intern", startDate: "2024-06", endDate: "2024-08", location: "", details: "" }] });
  for (const label of ["Address Line 1", "City", "State", "Zip Code", "Country", "Reason for Leaving"]) assert.equal(inWork(label, bare), undefined, label);
});

test("an employer's location labels (Oracle Recruiting Cloud's Employer City, Employer State or Province) take the work row's location", () => {
  const worked = profileSchema.parse({
    ...profile,
    work: [{ organization: "Acme", title: "Intern", startDate: "2024-06", endDate: "2024-08", location: "Roanoke, VA", details: "", county: "Roanoke", postalCode: "24060", country: "United States" }],
  });
  const inWork = (label: string) => deterministicAnswer(field(label, { section: "Experience", index: 0 }), worked);
  assert.equal(inWork("Employer City"), "Roanoke");
  assert.equal(inWork("Company City"), "Roanoke");
  assert.equal(inWork("Employer State or Province"), "VA");
  assert.equal(inWork("Employer State"), "VA");
  assert.equal(inWork("Employer County"), "Roanoke");
  assert.equal(inWork("Employer Zip Code"), "24060");
  assert.equal(inWork("Employer Country"), "United States");
});

test("a school list by campus picks the campus in the profile's city, and a long list is matched on the page", () => {
  const student = profileSchema.parse({ ...profile, education: [{ ...profile.education[0], organization: "University of Michigan", location: "Dearborn, MI" }] });
  const label = "Which university are you currently attending or did you last attend?";
  const campuses = ["Michigan State University", "University of Michigan - Ann Arbor", "University of Michigan - Dearborn", "University of Michigan - Flint"];
  assert.equal(proposals([field(label, { kind: "select", options: campuses })], student)[0]?.value, "University of Michigan - Dearborn");
  // No campus in the profile's city: none is guessed.
  const elsewhere = profileSchema.parse({ ...student, education: [{ ...student.education[0], location: "Detroit, MI" }] });
  assert.equal(proposals([field(label, { kind: "select", options: campuses })], elsewhere).length, 0);
  // Only the first 300 of 3,302 options were sent: the answer and its
  // alternatives go to the page, which holds the rest.
  const cut = proposals([field(label, { kind: "select", options: ["Aalborg University", "Aalto University"], optionCount: 3302 })], student)[0];
  assert.equal(cut?.value, "University of Michigan");
  assert.ok(cut?.choices?.includes("University of Michigan Dearborn"));
});

test("a school list names the profile's school by its official or common name, \"The\" or Main Campus, but never a sibling", () => {
  const label = "School";
  const list = [
    "Central Michigan University", "Georgia Institute of Technology-Main Campus", "Michigan State University", "Michigan State University College of Law",
    "Michigan Technological University", "The Ohio State University", "Ohio University", "Pennsylvania State University-Main Campus",
    "Pennsylvania State University-Penn State Harrisburg", "University of California-Berkeley", "University of California-Davis", "University of Michigan",
    "University of Virginia", "Virginia Polytechnic Institute and State University", "Virginia State University", "Virginia Tech Carilion School of Medicine",
  ];
  const pick = (organization: string, options = list) =>
    proposals([field(label, { kind: "select", options, section: "Education", index: 0 })], profileSchema.parse({ ...profile, education: [{ ...profile.education[0], organization, location: "" }] }))[0]?.value;
  assert.equal(pick("Virginia Tech"), "Virginia Polytechnic Institute and State University");
  assert.equal(pick("Virginia Polytechnic Institute and State University", list.map((option) => option.replace(/^Virginia Polytechnic.*/, "Virginia Tech"))), "Virginia Tech");
  assert.equal(pick("Ohio State University"), "The Ohio State University");
  assert.equal(pick("The Pennsylvania State University"), "Pennsylvania State University-Main Campus");
  assert.equal(pick("Georgia Tech"), "Georgia Institute of Technology-Main Campus");
  assert.equal(pick("UC Berkeley"), "University of California-Berkeley");
  assert.equal(pick("Michigan State University"), "Michigan State University");
  // Its siblings are not it: the medical school, another Virginia school,
  // the law college, or an initialism several schools share.
  const without = list.filter((option) => !/^(Virginia Polytechnic|Michigan State University$)/.test(option));
  assert.equal(pick("Virginia Tech", without), undefined);
  assert.equal(pick("Michigan State University", without), undefined);
  assert.equal(pick("MSU", [...list, "Mississippi State University"]), undefined);
});

test("a plain Location text box gets the applicant's city and state, but not inside a job row", () => {
  assert.equal(proposals([field("Location")], profile)[0]?.value, "Phoenix, Arizona");
  assert.equal(proposals([field("Location", { section: "Work Experience 1", index: 0 })], profile).length, 0);
  const picker = proposals([field("Location", { kind: "combobox" })], profile)[0];
  assert.equal(picker?.value, "Phoenix");
  assert.ok(picker?.choices?.includes("Phoenix, Arizona, United States"));
  assert.equal(proposals([field("Location", { kind: "combobox", section: "Work Experience 1", index: 0 })], profile).length, 0);
  assert.equal(proposals([field("Desired location")], profile).length, 0);
});

test("an abbreviation inside a question does not cut it, and Yes or No reach a sentence-worded option", async () => {
  const { pickOption } = await import("../src/shared/answers");
  const applicant = profileSchema.parse({ ...profile, workAuthorization: "Yes", sponsorship: "No" });
  const ask = (label: string) => proposals([field(label, { kind: "radio", options: ["Yes", "No"] })], applicant)[0]?.value;
  assert.equal(ask("Will you now, or in the future, require sponsorship for employment visa status (e.g. H-1B visa status)?"), "No");
  assert.equal(ask("Will you now, or in the future, require sponsorship (i.e. H-1B visa, etc.) to legally work in the US?"), "No");
  const pick = (value: string, options: string[]) => pickOption({ value }, options, (o) => o);
  assert.equal(pick("Yes", ["Yes, I am authorized to work in the United States", "No, I am not"]), "Yes, I am authorized to work in the United States");
  // A sentence that adds a claim answers a bare Yes or No only when the
  // question makes that claim itself.
  const asked = (value: string, question: string, options: string[]) => pickOption({ value, question }, options, (o) => o);
  assert.equal(asked("No", "Will you require sponsorship?", ["Yes", "No - I do not require sponsorship"]), "No - I do not require sponsorship");
  assert.equal(pick("No", ["Yes", "No - I do not require sponsorship"]), undefined);
  assert.equal(asked("Yes", "Are you legally authorized to work in the United States?", ["Yes, I am a U.S. citizen", "No"]), undefined);
  assert.equal(asked("Yes", "Are you legally authorized to work in the United States?", ["Yes, with sponsorship", "No"]), undefined);
  assert.equal(asked("Yes", "Will you now or in the future require visa sponsorship?", ["Yes, I will require sponsorship", "No"]), "Yes, I will require sponsorship");
  // Two "Yes…" options are two answers: neither is chosen. (Ones that add a
  // claim, a citizen or a visa, are not a bare Yes at all.)
  assert.equal(pick("Yes", ["Yes, as a citizen", "Yes, on a visa", "No"]), undefined);
  assert.throws(() => pick("Yes", ["Yes, I am authorized", "Yes, I am eligible", "No"]));
  assert.equal(pick("Yes", ["Yesterday", "Never"]), undefined);
  // A report (Greenhouse): one school listed twice, with a hyphen
  // and with a long dash. That is one answer; the same text twice is not.
  const school = "Pennsylvania State University - University Park";
  const dashed = "Pennsylvania State University — University Park";
  assert.equal(pick(school, [dashed, school, "Michigan State University"]), school);
  assert.equal(pick("Pennsylvania State University University Park", [dashed, school]), dashed);
  assert.throws(() => pick(school, [school, school]));
});


test("confirmed authorization answers an explicit OR with proof without claiming proof", () => {
  const label = "Are you lawfully authorized to work in the US or can you provide proof of employment eligibility upon hire?";
  for (const options of [[], ["Yes", "No"]]) {
    const question = field(label, { kind: "combobox", options });
    assert.equal(proposals([question], us(profile, "Yes"))[0]?.value, "Yes");
    assert.deepEqual(proposals([question], us(profile, "No")), []);
    assert.deepEqual(proposals([question], us(profile, "")), []);
  }
  assert.deepEqual(proposals([field("Can you provide proof that you are authorized to work in the United States?", { kind: "combobox", options: ["Yes", "No"] })], us(profile, "Yes")), []);
});


// One employer's Jobvite: "If hired, will you be able to provide proof of
// your legal right to work in the United States?" was left empty, with no
// reason, for a U.S. citizen, who has that proof by their status.
test("a U.S. citizen or permanent resident can provide proof of their right to work in the United States", () => {
  const label = "If hired, will you be able to provide proof of your legal right to work in the United States?";
  const question = field(label, { kind: "radio", options: ["Yes", "No", "Current Contoso team member"] });
  const status = (value: string) =>
    profileSchema.parse({ ...profile, citizenships: [], workAuthorization: [{ country: "US", status: value, needsSponsorship: value === "visa" }] });
  assert.equal(proposals([question], status("citizen"))[0]?.value, "Yes");
  assert.equal(proposals([question], status("permanent-resident"))[0]?.value, "Yes");
  assert.deepEqual(proposals([question], status("visa")), []);
  // A bare Yes to authorization still says nothing about documents.
  assert.deepEqual(proposals([question], us(profile, "Yes")), []);
});

test("relocation assistance in a permanent-address request does not infer an address", () => {
  const label = "Please provide your permanent address (city, state, zip code). We use this information to determine eligibility for relocation assistance for the internship. A permanent address is your long-term, stable address.";
  const p = { ...profile, willingToRelocate: "Yes", answers: [{ question: "Are you willing to relocate?", answer: "Yes" }] };
  assert.deepEqual(proposals([field(label)], p), []);
  assert.equal(proposals([field(label)], { ...p, answers: [{ question: label, answer: "100 Confirmed Permanent Ave, Phoenix, AZ 85001" }] })[0]?.value, "100 Confirmed Permanent Ave, Phoenix, AZ 85001");
  assert.equal(proposals([field("Are you willing to relocate?")], p)[0]?.value, "Yes");
});


test("CPT and OPT status stays manual while the exact no-sponsorship sentence expresses the confirmed answer", () => {
  const p = { ...us(profile, "Yes", "No"), answers: [] };
  const status = "Does your work authorization now, or will it in the future, involve CPT (Curricular Practical Training) or OPT (Optional Practical Training)?";
  for (const kind of ["select", "combobox", "radio", "text"] as const)
    assert.deepEqual(proposals([field(status, { kind, options: kind === "text" ? [] : ["Yes", "No"] })], p), []);
  assert.equal(proposals([field(status, { kind: "select", options: ["Yes", "No"] })], { ...p, answers: [{ question: status, answer: "No" }] })[0]?.value, "No");
  const label = "Do you now or will you ever require sponsorship for a work visa?";
  const exact = "I do not and will not require sponsorship at any point in the future in order to work in the US";
  const options = ["I require sponsorship to work in the US at this time", exact, "I am in the process of obtaining permanent work authorization but the process is not complete", "I do not require sponsorship right now, but will at some point in the future"];
  assert.equal(proposals([field(label, { kind: "select", options })], p)[0]?.value, exact);
  assert.deepEqual(proposals([field(label, { kind: "select", options: options.filter(x => x !== exact) })], p), []);
  assert.deepEqual(proposals([field(label, { kind: "select", options })], us(p, "Yes", "")), []);
});

test("an explicitly saved now-or-future No distinguishes the two No sponsorship sentences", () => {
  const label = "Do you now or in the future require sponsorship for employment visa status to work in the United States?";
  const complete = "No, I do not require sponsorship now or in the future";
  const partial = "No, I do not require sponsorship now, but may require it in the future";
  const options = [complete, partial, "Yes, I currently hold a visa status that would require a transfer to a new employer", "Yes, I would require new sponsorship"];
  const p = { ...us(profile, "", "No"), answers: [{ question: "Will you now or in the future require sponsorship?", answer: "No" }] };
  const pick = (choices = options, applicant = p) => proposals([field(label, { kind: "radio", options: choices })], applicant);
  assert.equal(pick()[0]?.value, complete);
  assert.deepEqual(pick(options, { ...p, answers: [] }), []);
  assert.deepEqual(pick([complete, options[2]], { ...p, answers: [] }), []);
  assert.deepEqual(pick(options, { ...p, answers: [...p.answers, { question: p.answers[0].question, answer: "Yes" }] }), []);
  assert.deepEqual(pick(options, { ...p, answers: [...p.answers, { question: label, answer: "Yes" }] }), []);
  assert.deepEqual(pick(options, { ...p, answers: [...p.answers, { question: p.answers[0].question, answer: "" }] }), []);
  assert.equal(pick(options, { ...p, answers: [...p.answers, ...p.answers] })[0]?.value, complete);
  assert.deepEqual(proposals([field(label, { kind: "radio", options: ["Yes", "No"] })], {
    ...p, answers: [{ question: label, answer: "No" }, { question: label, answer: "Yes" }],
  }), []);
  assert.deepEqual(pick(options, us(p, "", "")), []);
  assert.deepEqual(pick([partial, options[2], options[3]]), []);
  const exactBinary = { ...p, answers: [{ question: label, answer: "No" }] };
  assert.equal(pick(options, exactBinary)[0]?.value, complete);
  assert.deepEqual(pick([partial, options[2]], exactBinary), []);
  assert.deepEqual(pick(options, { ...exactBinary, answers: [...exactBinary.answers, { question: label, answer: "Yes" }] }), []);
  const requiresSponsorship = { ...us(p, "", "Yes"), answers: [{ question: label, answer: "Yes" }] };
  assert.deepEqual(pick([complete, options[2]], requiresSponsorship), []);
  assert.deepEqual(pick([complete, options[3]], requiresSponsorship), []);
  assert.equal(pick([complete, "Yes"], requiresSponsorship)[0]?.value, "Yes");
  assert.equal(pick(options, { ...p, answers: [{ question: label, answer: options[2] }] })[0]?.value, options[2]);
  assert.deepEqual(pick([complete, complete, partial]), []);
  const foreignLabel = label.replace("United States", "Canada");
  const foreignField = field(foreignLabel, { kind: "radio", options: [partial, options[2]] });
  assert.deepEqual(proposals([foreignField], p), []);
  assert.deepEqual(proposals([foreignField], { ...p, answers: [{ question: foreignLabel, answer: "No" }] }), []);
  assert.deepEqual(proposals([field(label.replace("United States", "Canada"), { kind: "radio", options })], p), []);
});

test("confirmed citizenship and authorization select only the exact citizen-or-resident statement", () => {
  const label = "Are you currently authorized to work for any employer in the United States?";
  const citizen = "Yes - I have US work authorization as a Citizen or US Permanent Resident / Green Card Holder";
  const visa = "Yes - I have US work authorization via a non-immigrant visa (e.g. F-1, H-1B, L-1, TN)";
  const options = [citizen, visa, "No - I am not currently authorized to work in the US"];
  const p = { ...us(profile, "Yes"), answers: [{ question: "Are you a U.S. citizen?", answer: "Yes" }] };
  const pick = (applicant = p, choices = options) => proposals([field(label, { kind: "radio", options: choices })], applicant);
  assert.equal(pick()[0]?.value, citizen);
  assert.deepEqual(pick({ ...p, answers: [] }), []);
  assert.deepEqual(pick({ ...p, answers: [...p.answers, { question: p.answers[0].question, answer: "No" }] }), []);
  assert.deepEqual(pick({ ...p, answers: [...p.answers, { question: p.answers[0].question, answer: "" }] }), []);
  assert.equal(pick({ ...p, answers: [...p.answers, ...p.answers] })[0]?.value, citizen);
  assert.deepEqual(pick({ ...p, answers: [{ question: "Are you a U.S. citizen?", answer: "No" }] }), []);
  assert.deepEqual(pick(us(p, "")), []);
  assert.deepEqual(pick(p, [citizen, citizen, visa]), []);
  const exactBinary = { ...p, answers: [...p.answers, { question: label, answer: "Yes" }] };
  assert.equal(pick(exactBinary)[0]?.value, citizen);
  assert.deepEqual(pick(exactBinary, [visa, options[2]]), []);
  assert.deepEqual(pick({ ...exactBinary, answers: [{ question: label, answer: "Yes" }] }), []);
  assert.deepEqual(pick({ ...exactBinary, answers: [...exactBinary.answers, { question: label, answer: "No" }] }), []);
  assert.deepEqual(pick(us(exactBinary, "No")), []);
  assert.equal(pick({ ...p, answers: [{ question: label, answer: citizen }] })[0]?.value, citizen);
  assert.deepEqual(pick(p, [visa, options[2]]), []);
  const foreignLabel = label.replace("United States", "Canada");
  assert.deepEqual(proposals([field(foreignLabel, { kind: "radio", options: [visa, options[2]] })], {
    ...p, answers: [{ question: foreignLabel, answer: "Yes" }],
  }), []);
  assert.deepEqual(proposals([field(label.replace("United States", "Canada"), { kind: "radio", options })], p), []);
});


test("late dropdown options cannot add visa or future facts to a bare saved binary answer", async () => {
  const { pickOption, qualifiedBinarySentences } = await import("../src/shared/answers");
  for (const sentence of Object.values(qualifiedBinarySentences).flat()) {
    const binary = sentence.startsWith("Yes") ? "Yes" : "No";
    assert.equal(pickOption({ value: binary }, [sentence], option => option), undefined, sentence);
    assert.equal(pickOption({ value: sentence }, [sentence], option => option), sentence);
    assert.equal(pickOption({ value: binary, choices: [sentence] }, [sentence], option => option), sentence);
  }
  assert.equal(pickOption({ value: "Yes" }, ["Yes, I am authorized to work in the United States"], option => option), "Yes, I am authorized to work in the United States");
  assert.equal(pickOption({ value: "No", question: "Do you require sponsorship?" }, ["No, I do not require sponsorship"], option => option), "No, I do not require sponsorship");
  // Without the question, a sentence that adds a claim is not taken.
  assert.equal(pickOption({ value: "No" }, ["No, I do not require sponsorship"], option => option), undefined);
});

// Reports on two Ashby forms.
test("one box of a checkbox question is ticked only when it is the profile's answer to that question", () => {
  const applicant = profileSchema.parse({
    ...profile,
    sexualOrientation: "Straight",
    education: [
      { organization: "State University", title: "Masters of Science", fieldOfStudy: "Data Science", startDate: "2025-08-21", endDate: "2099-05-10" },
      { organization: "Virginia Tech", title: "Bachelors of Science", fieldOfStudy: "Computer Science", startDate: "2020-09-13", endDate: "2024-06-15" },
    ],
  });
  const boxes = (question: string | undefined, labels: string[]) =>
    proposals(labels.map((label, index) => field(label, { id: `box-${index}`, kind: "checkbox", options: ["Yes", "No"], question })), applicant).map((proposal) => proposal.fieldId);
  // "Degree Type" beside the school being attended is the degree in
  // progress there: the bachelor's the applicant also holds was ticked too.
  assert.deepEqual(boxes("Degree Type", ["Undergraduate/Bachelors", "Master's", "PhD", "MBA"]), ["box-1"]);
  // The orientation the profile holds, in the form's wording, and nothing else.
  assert.deepEqual(boxes("What is your sexual orientation? Please select all that apply.", ["Bisexual", "Lesbian", "Gay", "Queer", "Heterosexual / straight", "Other", "I prefer not to answer"]), ["box-4"]);
  // Without their question the same boxes say nothing, and a question that
  // is not one of these is left alone.
  assert.deepEqual(boxes(undefined, ["Undergraduate/Bachelors", "Master's", "Heterosexual / straight"]), []);
  assert.deepEqual(boxes("Which of the following communities do you belong to?", ["Parent", "Neurodiverse", "None of the above"]), []);
});

test("a graduation date box gets the whole date, and a season its term", () => {
  const applicant = profileSchema.parse({ ...profile, education: [{ organization: "State University", title: "Masters of Science", startDate: "2025-08-21", endDate: "2099-05-10" }] });
  const pick = (label: string, overrides: Partial<Field> = {}, who = applicant) => proposals([field(label, overrides)], who)[0]?.value;
  // Typed "May 2099", a date picker made it the 1st.
  assert.equal(pick("Graduation Date"), "05/10/2099");
  assert.equal(pick("Graduation Date", { kind: "date" }), "2099-05-10");
  // A profile date without a day, and a question for the month or year, are as before.
  assert.equal(pick("Graduation Date", {}, profile), "May 2028");
  assert.equal(pick("Expected graduation month"), "May 2099");
  assert.equal(pick("Graduation year"), "2099");
  const seasons = { kind: "radio", options: ["Winter 2099", "Spring 2099", "Fall 2099"] };
  assert.equal(pick("What is your ancitipated graduation season?", seasons), "Spring 2099");
  assert.equal(pick("Anticipated graduation term", seasons), "Spring 2099");
  // December is the Fall term and winter by the calendar: only a list with one of them is answered.
  const december = profileSchema.parse({ ...profile, education: [{ organization: "State University", title: "Masters of Science", startDate: "2025-08-21", endDate: "2099-12-13" }] });
  assert.equal(pick("Anticipated graduation season", seasons, december), undefined);
  assert.equal(pick("Anticipated graduation season", { kind: "radio", options: ["Spring 2099", "Fall 2099"] }, december), "Fall 2099");
  // A season with no year the list offers is left alone.
  assert.equal(pick("Anticipated graduation season", { kind: "radio", options: ["Spring 2098", "Fall 2098"] }), undefined);
  // "Expected month and year of graduation" as single seasons beside a
  // catch-all with no date (Lever): December takes the year's Winter when
  // no Fall of it is offered; a month no option holds is left alone.
  const single = { kind: "radio", options: ["Summer 2099", "Winter 2099", "Spring 2100", "Summer 2100", "Future Graduation Date"] };
  assert.equal(pick("What is your expected month and year of graduation?", single, december), "Winter 2099");
  assert.equal(pick("What is your expected month and year of graduation?", single), undefined);
  // A list of spans takes the one holding the month (one employer's
  // Oracle form), and a list read only when opened can match it.
  const quarters = { kind: "select", options: ["January - March 2099", "April - June 2099", "July - September 2099", "October - December 2099", "January - March 2100"] };
  assert.equal(pick("What is your expected graduation date:", quarters, december), "October - December 2099");
  assert.equal(pick("What is your expected graduation date:", quarters), "April - June 2099");
  assert.equal(pick("What is your expected graduation date:", { kind: "select", options: ["January - March 2099", "April - June 2099"] }, december), undefined);
  const opened = proposals([field("What is your expected graduation date:", { kind: "combobox" })], december)[0]!;
  assert.equal(pickListOption(opened, quarters.options, (option) => option), "October - December 2099");
  // Amazon's names the format, and its question is asked another way.
  assert.equal(pick("In what month and year did you (or do you expect to) graduate from your highest degree? Date: Year-Month-Day", { kind: "datepicker" }, december), "2099-12-13");
});

test("name pronunciation, transgender and age come from the profile, and stay empty without it", () => {
  const born = new Date();
  born.setFullYear(born.getFullYear() - 27);
  born.setDate(born.getDate() - 1);
  const applicant = profileSchema.parse({ ...profile, namePronunciation: "AL-ex", transgender: "No", dateOfBirth: born.toISOString().slice(0, 10) });
  const pick = (label: string, overrides: Partial<Field> = {}, who = applicant) => proposals([field(label, overrides)], who)[0]?.value;
  assert.equal(pick("Name pronounciation"), "AL-ex");
  assert.equal(pick("Phonetic spelling of your name"), "AL-ex");
  assert.equal(pick("What pronouns do you use?"), undefined);
  assert.equal(pick("Do you identify as transgender?", { kind: "radio", options: ["Yes", "No", "I prefer not to answer"] }), "No");
  const ranges = { kind: "radio", options: ["Under 30", "30-39", "40-49", "50-59", "60 or older", "I prefer not to answer"] };
  assert.equal(pick("What is your current age?", ranges), "Under 30");
  assert.equal(pick("Age"), "27");
  const older = new Date();
  older.setFullYear(older.getFullYear() - 61);
  assert.equal(pick("What is your current age?", ranges, profileSchema.parse({ ...profile, dateOfBirth: older.toISOString().slice(0, 10) })), "60 or older");
  // A threshold is calculated from the same birthday; no duplicate age
  // declaration or model is needed.
  assert.equal(pick("Are you at least 18 years of age?", { kind: "radio", options: ["Yes", "No"] }), "Yes");
  assert.equal(pick("Are you at least 18 years of age?", { kind: "radio", options: ["Yes", "No"] }, profile), undefined);
  for (const [label, overrides] of [["Name pronounciation", {}], ["Do you identify as transgender?", { kind: "radio", options: ["Yes", "No"] }], ["What is your current age?", ranges]] as [string, Partial<Field>][])
    assert.equal(pick(label, overrides, profile), undefined, label);
});

// JazzHR asks for the school, major
// and degree of one level of study, and for the highest degree's date.
test("a question naming a level of study is answered from the education row at that level", () => {
  const applicant = profileSchema.parse({
    ...profile,
    education: [
      { organization: "Michigan State University", title: "Masters of Science", fieldOfStudy: "Data Science", startDate: "2025-08-21", endDate: "2099-05-10" },
      { organization: "Virginia Polytechnic Institute and State University", title: "Bachelors of Science", fieldOfStudy: "Computer Science", startDate: "2020-09-13", endDate: "2024-06-15" },
    ],
  });
  const schools = ["-- No answer --", "Virginia Polytechnic Institute and State University", "Michigan State University", "Other (US Based Schools)"];
  const ask = (label: string, overrides: Partial<Field> = {}) => proposals([field(label, overrides)], applicant)[0];
  assert.equal(ask("Highest Degree Earned/Pursuing", { kind: "select", options: ["-- No answer --", "Bachelor", "Master", "PhD"] })?.value, "Master");
  assert.ok(ask("Highest Degree Earned/Pursuing")?.choices?.includes("Master"));
  // A degree still in progress is not one earned.
  assert.equal(ask("Highest degree earned")?.value, "Bachelors of Science");
  // Nor is it the "highest level of education" asked bare: a text box names
  // the finished degree and the one under way; a list takes the finished one.
  assert.equal(ask("What is your highest level of education?", { kind: "textarea" })?.value, "Bachelors of Science (Masters of Science in progress, expected May 2099)");
  assert.equal(ask("What is your highest level of education?", { kind: "select", options: ["-- No answer --", "Bachelor", "Master", "PhD"] })?.value, "Bachelor");
  assert.equal(ask("Completion date of your highest degree (mm/yyyy)")?.value, "05/2099");
  assert.equal(ask("Name of the School: Undergraduate Degree", { kind: "select", options: schools })?.value, "Virginia Polytechnic Institute and State University");
  assert.equal(ask("Name of the School: Graduate/MBA/PhD Degree", { kind: "select", options: schools })?.value, "Michigan State University");
  assert.equal(ask("Field of Study / Major: Undergraduate Degree")?.value, "Computer Science");
  assert.equal(ask("Field of Study: Graduate/MBA/PhD Degree")?.value, "Data Science");
  // Two graduate programs: which one a graduate question means is unknown.
  const twice = profileSchema.parse({
    ...applicant,
    education: [...applicant.education, { organization: "Harbor Business School", title: "MBA", startDate: "2018-08", endDate: "2020-05" }],
  });
  assert.equal(proposals([field("Name of the School: Graduate/MBA/PhD Degree")], twice).length, 0);
});

// JazzHR draws a yes/no question as
// one checkbox per answer, the question carried by each box.
test("Yes and No drawn as boxes of a sponsorship question tick the profile's answer", () => {
  const applicant = profileSchema.parse({ ...profile, workAuthorization: "Yes", sponsorship: "No" });
  const question =
    "Will you in the future (beyond the expiration of your current visa status, such as F-1 student status with OPT eligibility), require sponsorship for employment visa status (such as H-1B, TN, O1 visa statuses, etc.) to work legally for our Company in the United States?";
  const boxes = ["Yes", "No", "Other (please explain below)"].map((label, index) =>
    field(label, { id: `box${index}`, kind: "checkbox", options: ["Yes", "No"], required: false, question }),
  );
  const ticked = (applicantProfile: typeof applicant) =>
    Object.fromEntries(proposals(boxes, applicantProfile).map((proposal) => [proposal.fieldId, proposal.value]));
  assert.deepEqual(ticked(applicant), { box1: "Yes" });
  assert.deepEqual(ticked(profileSchema.parse(us(applicant, "Yes", "Yes"))), { box0: "Yes" });
  // Another country's sponsorship is not the profile's to answer.
  const abroad = boxes.map((box) => ({ ...box, question: "Will you require sponsorship to work in Canada?" }));
  assert.equal(proposals(abroad, applicant).length, 0);
});

// The applicant asked: forms that ask for a full legal name did
// not get the middle name. It is its own profile value now.
test("a legal name includes the middle name, an everyday full name does not", () => {
  const named = profileSchema.parse({ confirmed: true, firstName: "Alex", middleName: "Jordan", lastName: "Rivera", email: "alex@example.test", facts: [], work: [], education: [], skills: [], answers: [] });
  const value = (label: string) => proposals([field(label)], named)[0]?.value;
  assert.equal(value("Full legal name"), "Alex Jordan Rivera");
  assert.equal(value("Legal Name"), "Alex Jordan Rivera");
  assert.equal(value("Please state your full legal name:"), "Alex Jordan Rivera");
  assert.equal(value("Middle name"), "Jordan");
  assert.equal(value("Middle initial"), "J");
  assert.equal(value("Full name"), "Alex Rivera");
  assert.equal(value("First and last name"), "Alex Rivera");
  // Without a middle name saved, the legal name is the first and last name,
  // and a middle-name box is left as it is.
  const plain = { ...named, middleName: undefined };
  assert.equal(proposals([field("Full legal name")], plain)[0]?.value, "Alex Rivera");
  assert.equal(proposals([field("Middle name")], plain)[0], undefined);
});

// JazzHR: the school lists lacked the
// applicant's schools, and each was followed by a box for the name of one
// chosen as "Other"; the applicant asked for Other and the name.
test("a school list without the school picks its Other, and the box after it gets the name", () => {
  const applicant = profileSchema.parse({
    ...profile,
    education: [
      { organization: "Michigan State University", title: "Masters of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2099-05", location: "East Lansing, MI" },
      { organization: "Virginia Polytechnic Institute and State University", title: "Bachelors of Science", fieldOfStudy: "Computer Science", startDate: "2020-09", endDate: "2024-06", location: "Blacksburg, Virginia" },
    ],
  });
  const lists = (others: string[]) => [
    field("Name of the School: Undergraduate Degree", { id: "under", kind: "select", options: ["-- No answer --", "Bucknell University", ...others] }),
    field('If you selected "OTHER" , please enter the full name of the school where you are pursuing your Undergraduate degree', { id: "underName", required: false }),
    field("Field of Study / Major: Undergraduate Degree", { id: "major" }),
    field("Name of the School: Graduate/MBA/PhD Degree", { id: "grad", kind: "select", options: ["-- No answer --", "Bucknell University", ...others], required: false }),
    field('If you selected "OTHER" , please enter the full name of the school where you are pursuing your Graduate/MBA/PhD', { id: "gradName", required: false }),
  ];
  const answers = (fields: Field[], who = applicant) => Object.fromEntries(proposals(fields, who).map((proposal) => [proposal.fieldId, proposal.value]));
  assert.deepEqual(answers(lists(["Other (International Schools)", "Other (US Based Schools)"])), {
    under: "Other (US Based Schools)",
    underName: "Virginia Polytechnic Institute and State University",
    major: "Computer Science",
    grad: "Other (US Based Schools)",
    gradName: "Michigan State University",
  });
  // A listed school is chosen itself, and its box is left.
  const listed = lists(["Virginia Polytechnic Institute and State University", "Other (US Based Schools)"]);
  assert.equal(answers(listed).under, "Virginia Polytechnic Institute and State University");
  assert.equal(answers(listed).underName, undefined);
  // Without a place to tell US from international, neither Other is chosen.
  const placeless = profileSchema.parse({ ...applicant, education: applicant.education.map((row) => ({ ...row, location: "" })) });
  const unknown = answers(lists(["Other (International Schools)", "Other (US Based Schools)"]), placeless);
  assert.equal(unknown.under, undefined);
  assert.equal(unknown.underName, undefined);
  // No box for the name: the list is left, as before.
  assert.equal(answers(lists(["Other (US Based Schools)"]).filter((f) => !/Name$/.test(f.id))).under, undefined);
});

// SuccessFactors (Contoso Energy Group) asks about
// sponsorship without the word: "…commence an immigration case in order to
// employ you? (e.g. H-1B…)". Its list loads only when opened.
test("asking an employer to commence an immigration case is a sponsorship question", () => {
  const applicant = profileSchema.parse({ ...profile, workAuthorization: "Yes", sponsorship: "No" });
  const ask = (label: string) => proposals([field(label, { kind: "combobox" })], applicant)[0]?.value;
  assert.equal(ask("Will you now or in the future ask Contoso Energy Group or any of our subsidiaries to commence an immigration case in order to employ you? (e.g. H-1B or other immigration cases)"), "No");
  assert.equal(ask("Will you now or in the future ask Acme to file an immigration petition on your behalf?"), "No");
  // Another country's case is not the profile's to answer.
  assert.equal(ask("Will you ask Acme to commence an immigration case to work in Canada?"), undefined);
});

// Ashby asks "Do you currently have an
// active immigration case (ex H-1B extension, green card)?" and it was left
// to the applicant. A U.S. citizen has none; anyone else might.
test("a citizen has no active immigration case", () => {
  const ask = (workAuthorization: string, label = "Do you currently have an active immigration case (ex H-1B extension, green card)?") =>
    proposals([field(label, { kind: "radio" })], profileSchema.parse({ ...profile, workAuthorization, sponsorship: "No" }))[0]?.value;
  assert.equal(ask("US Citizen"), "No");
  assert.equal(ask("U.S. citizen", "Do you have a pending immigration petition?"), "No");
  assert.equal(ask("Green Card Holder"), undefined);
  assert.equal(ask("Yes"), undefined);
});

// one employer's SuccessFactors form asks these as
// sentences: the highest level completed is the finished degree; the major
// is the program studied now (the model gave the finished degree's); and
// "Date Available" is a date picker that reads as a text box.
test("SuccessFactors' education sentences and its availability date are answered from the profile", () => {
  const applicant = profileSchema.parse({
    ...profile,
    answers: [{ question: "When can you start?", answer: "Immediately" }],
    education: [
      { organization: "Michigan State University", title: "Masters of Science", fieldOfStudy: "Data Science", startDate: "2025-08-21", endDate: "2099-05-10" },
      { organization: "Virginia Polytechnic Institute and State University", title: "Bachelors of Science", fieldOfStudy: "Computer Science", startDate: "2020-09-13", endDate: "2024-06-15" },
    ],
  });
  const ask = (label: string, overrides: Partial<Field> = {}) => proposals([field(label, overrides)], applicant)[0]?.value;
  assert.equal(ask("What is the highest level of education you have completed?", { kind: "select", options: ["High School", "Bachelors Degree", "Masters Degree or Higher"] }), "Bachelors Degree");
  assert.equal(ask("What area was your major in?"), "Data Science");
  // BambooHR's list puts "College - " before each degree: the finished
  // Bachelor of Science is its own option, not the Arts one or the Master's.
  const bamboo = ["GED or Equivalent", "High School", "Some College", "College - Associates", "College - Bachelor of Arts", "College - Bachelor of Fine Arts", "College - Bachelor of Science", "College - Master of Arts", "College - Master of Science", "College - Doctorate", "Other"];
  assert.equal(ask("Highest Education Obtained", { kind: "combobox", options: bamboo }), "College - Bachelor of Science");
  // JazzHR asks the same list as a plain select, worded "What's …".
  assert.equal(ask("What's your highest level of education completed?", { kind: "select", options: bamboo }), "College - Bachelor of Science");
  const today = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  assert.equal(ask("Date Available"), `${two(today.getMonth() + 1)}/${two(today.getDate())}/${today.getFullYear()}`);
});

// Amazon's internship form names its date
// format in the label, and "10/25/2026" was "not in the correct format".
test("a start-date picker whose label names Year-Month-Day gets today's date in that format", () => {
  const applicant = profileSchema.parse({ ...profile, answers: [{ question: "When can you start?", answer: "Immediately" }] });
  const today = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  const value = proposals([
    field("What is your earliest possible start date for this internship term? (required) Date: Year-Month-Day Please enter the date in the format YYYY dash MM dash DD", { kind: "datepicker" }),
  ], applicant)[0]?.value;
  assert.equal(value, `${today.getFullYear()}-${two(today.getMonth() + 1)}-${two(today.getDate())}`);
});

// one employer's SuccessFactors profile: "Degree Conferred" is a
// date, and the model wrote "Bachelors of Science" into it. A finished
// degree gives its end date. One in progress is conferred on its expected
// date but not yet received.
test("a degree-conferred box gets the degree's date, expected for one in progress, and degree-received only a finished one's", () => {
  const applicant = profileSchema.parse({
    ...profile,
    education: [
      { organization: "Michigan State University", title: "Masters of Science", fieldOfStudy: "Data Science", startDate: "2025-08-21", endDate: "2099-05-10" },
      { organization: "Virginia Polytechnic Institute and State University", title: "Bachelors of Science", fieldOfStudy: "Computer Science", startDate: "2020-09-13", endDate: "2024-06-15" },
    ],
  });
  const ask = (index: number, label = "Degree Conferred") => proposals([field(label, { section: "Education", index })], applicant)[0]?.value;
  assert.equal(ask(1), "06/15/2024");
  assert.equal(ask(0), "05/10/2099");
  assert.equal(ask(1, "Degree Received"), "06/15/2024");
  assert.equal(ask(0, "Degree Received"), undefined);
});

// an employer asks "What year did you or, if you
// have not graduated, will you receive your degree?" twice: once in a text
// box, which takes the year, and once in a date picker, where "2027" was
// invalid: it takes the whole expected date.
test("a will-you-receive-your-degree question gets the year in a text box and the date in a date picker", () => {
  const applicant = profileSchema.parse({
    ...profile,
    education: [
      { organization: "Michigan State University", title: "Masters of Science", fieldOfStudy: "Data Science", startDate: "2025-08-21", endDate: "2099-05-10" },
      { organization: "Virginia Polytechnic Institute and State University", title: "Bachelors of Science", fieldOfStudy: "Computer Science", startDate: "2020-09-13", endDate: "2024-06-15" },
    ],
  });
  const ask = (label: string, kind: string) => proposals([field(label, { kind, section: "Job-Specific Information" })], applicant)[0]?.value;
  assert.equal(ask("What year did you or, if you have not graduated, will you receive your degree?", "text"), "2099");
  assert.equal(ask("What year did you or if you have not graduated will you receive your degree?", "datepicker"), "05/10/2099");
});

// an employer asks "Please indicate your current year of study in
// college." as a list and as a text box. An M.S. begun more than a year ago
// is in its second year: a graduate student, never an undergraduate class.
test("the current year of study is counted from the program under way", () => {
  const started = (monthsAgo: number) => {
    const date = new Date();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() - monthsAgo);
    return date.toISOString().slice(0, 10);
  };
  const applicant = (title: string, startDate: string) =>
    profileSchema.parse({
      ...profile,
      education: [
        { organization: "Michigan State University", title, fieldOfStudy: "Data Science", startDate, endDate: "2099-05-10" },
        { organization: "Virginia Polytechnic Institute and State University", title: "Bachelors of Science", fieldOfStudy: "Computer Science", startDate: "2020-09-13", endDate: "2024-06-15" },
      ],
    });
  const ask = (person: ReturnType<typeof applicant>, kind: string) =>
    proposals([field("Please indicate your current year of study in college.", { kind, section: "Job-Specific Information" })], person)[0];
  const master = applicant("Masters of Science", started(14));
  assert.equal(ask(master, "textarea")?.value, "Second year of graduate study");
  assert.equal(ask(master, "combobox")?.value, "Graduate Student");
  assert.ok(!ask(master, "combobox")?.choices?.includes("Sophomore"));
  const bachelor = applicant("Bachelor of Science", started(26));
  assert.equal(ask(bachelor, "combobox")?.value, "Junior");
  assert.equal(ask(bachelor, "text")?.value, "Third year (Junior)");
});

// one employer's Workday form: the site's "Masters" from the resume is
// the profile's "Masters of Science" in another wording, and was replaced
// anyway, opening the list again.
test("a value the site filled in one of the answer's wordings is left as it is", () => {
  const applicant = profileSchema.parse({
    ...profile,
    education: [{ organization: "Michigan State University", title: "Masters of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2099-05" }],
  });
  const degree = (value: string) => proposals([field("Degree", { kind: "combobox", section: "Education", value, siteValue: true })], applicant);
  assert.deepEqual(degree("Masters"), []);
  assert.equal(degree("Bachelors")[0]?.value, "Masters of Science");
});

// Northwind's SuccessFactors: "Are you one of the
// following? U.S. Citizen or National, U.S. Lawful Permanent Resident…" and
// then the countries of citizenship, the latest first as "Country 1 Name".
test("a citizen answers which of the following they are, and names the United States first", () => {
  const citizen = profileSchema.parse({ ...profile, workAuthorization: "US Citizen" });
  const question = "Are you one of the following? U.S. Citizen or National U.S. Lawful Permanent Resident. Person granted Refugee status in the United States. Person granted Asylum in the United States.";
  const answered = proposals([
    field(question, { id: "status", kind: "combobox", options: ["No Selection", "No", "Yes"] }),
    field("Country 1 Name", { id: "first", kind: "combobox" }),
    field("Country 2 Name", { id: "second", kind: "combobox", required: false }),
  ], citizen);
  assert.deepEqual(answered.map((proposal) => [proposal.fieldId, proposal.value]), [["status", "Yes"], ["first", "United States"]]);
  // Nothing saved says citizen: nothing is said.
  assert.deepEqual(proposals([field(question, { kind: "combobox", options: ["No", "Yes"] }), field("Country 1 Name", { kind: "combobox" })], profile), []);
});

// Northwind's SuccessFactors: beside "Country 1
// Name" is a required "Type of Status 1", which was left empty for a citizen.
test("a citizen's first country of citizenship is held as a citizen", () => {
  const citizen = profileSchema.parse({ ...profile, workAuthorization: "US Citizen" });
  const answered = proposals([
    field("Type of Status 1", { id: "first", kind: "combobox" }),
    field("Type of Status 2", { id: "second", kind: "combobox", required: false }),
  ], citizen);
  assert.deepEqual(answered.map((proposal) => [proposal.fieldId, proposal.value]), [["first", "Citizen"]]);
  assert.ok(answered[0].choices?.includes("U.S. Citizen"));
  assert.deepEqual(proposals([field("Type of Status 1", { kind: "combobox" })], profile), []);
});

// Northwind's SuccessFactors: "Have you
// worked for Contoso in the past 12 months?" and "Were you referred by
// someone at Contoso?" were left empty, both required.
test("working there recently and a referral from someone there are answered from the profile", () => {
  const applicant = profileSchema.parse({
    ...profile,
    priorEmployment: "No",
    work: [{ organization: "Northwind Labs", title: "Intern", startDate: "2025-01", endDate: "", details: "", location: "" }],
    references: [{ name: "Jordan Lee", relationship: "Director of Northwind Labs", phone: "", email: "jordan@example.com" }],
  });
  const answer = (label: string, who = applicant) => proposals([field(label, { kind: "combobox" })], who)[0]?.value;
  assert.equal(answer("Have you worked for Contoso in the past 12 months?"), "No");
  assert.equal(answer("Were you referred by someone at Contoso?"), "No");
  assert.equal(answer("Were you referred by someone at Contoso Electric Company, LLC?"), "No");
  // Someone who vouches for the applicant works there, or the question is
  // about the applicant's own employer, or names no company: left alone.
  assert.equal(answer("Were you referred by someone at Northwind Labs?"), undefined);
  assert.equal(answer("Have you worked for Northwind Labs in the past 12 months?"), undefined);
  assert.equal(answer("Were you referred by someone?"), undefined);
  // A saved answer to the question is used instead.
  const saved = profileSchema.parse({ ...applicant, answers: [{ question: "Were you referred by an employee?", answer: "Yes" }] });
  assert.equal(answer("Were you referred by someone at Contoso?", saved), "Yes");
});

// one employer's SuccessFactors asks each
// school's Country, State and City. Penn State's got the applicant's home,
// Arizona, and the school list that follows the State then held no Penn State.
test("a school's or job's City, State and Country are its own, not the applicant's home", () => {
  const applicant = profileSchema.parse({
    ...profile,
    city: "Tucson",
    state: "Arizona",
    country: "United States",
    education: [
      { organization: "Michigan State University", title: "Master of Science", location: "East Lansing, MI", startDate: "2025-08", endDate: "2027-05", details: "" },
      { organization: "Pennsylvania State University, University Park", title: "Bachelors of Science", location: "University Park, Pennsylvania", startDate: "2020-09", endDate: "2024-06", details: "" },
      { organization: "Online Academy", title: "Certificate", location: "", startDate: "2019", endDate: "2019", details: "" },
    ],
  });
  const ask = (label: string, index: number, kind = "combobox") =>
    proposals([field(label, { kind, section: "What is your educational background?", index })], applicant)[0];
  assert.equal(ask("State", 1)?.value, "Pennsylvania");
  assert.ok(ask("State", 1)?.choices?.includes("PA"));
  assert.equal(ask("State", 0)?.value, "Michigan");
  assert.equal(ask("* City", 1, "text")?.value, "University Park");
  assert.equal(ask("Country", 1)?.value, "United States");
  // A school with no place saved is not given the applicant's.
  assert.equal(ask("State", 2), undefined);
  assert.equal(ask("* City", 2, "text"), undefined);
  // Outside a school or job row, the home address still answers.
  assert.equal(proposals([field("State", { kind: "combobox" })], applicant)[0]?.value, "Arizona");
});

// one employer's SuccessFactors asks "* City" in a text box;
// "Tucson" there became "Tucson, Arizona".
test("a text box asking only for the city gets only the city", () => {
  const applicant = profileSchema.parse({ ...profile, city: "Tucson", state: "Arizona", country: "United States" });
  assert.equal(proposals([field("* City")], applicant)[0]?.value, "Tucson");
  assert.equal(proposals([field("City")], applicant)[0]?.value, "Tucson");
  // A box asking where the applicant lives still gets the state.
  assert.equal(proposals([field("Where are you currently located? (City, State)")], applicant)[0]?.value, "Tucson, Arizona");
});

// one employer's SuccessFactors: each school's
// "Education Type" (College, GED, High School, Junior College, Trade School)
// and "What date are you available to start work?" were left empty.
test("a school's education type comes from its degree, and a start date is asked as a date", () => {
  const applicant = profileSchema.parse({
    ...profile,
    education: [
      { organization: "Michigan State University", title: "Masters of Science", startDate: "2025-08", endDate: "2027-05", location: "", details: "" },
      { organization: "Mesa Community College", title: "Associate of Arts", startDate: "2018-08", endDate: "2020-05", location: "", details: "" },
    ],
    answers: [{ question: "When can you start?", answer: "Immediately" }],
  });
  const type = (index: number) =>
    proposals([field("Education Type", { kind: "combobox", section: "What is your educational background?", index })], applicant)[0]?.value;
  assert.equal(type(0), "College");
  assert.equal(type(1), "Junior College");
  // Outside a school's row it says nothing.
  assert.equal(proposals([field("Education Type", { kind: "combobox" })], applicant)[0]?.value, undefined);
  const start = proposals([field("What date are you available to start work?", { kind: "datepicker" })], applicant)[0]?.value || "";
  assert.match(start, /^\d{2}\/\d{2}\/\d{4}$/);
  // Without a saved answer the date is not made up.
  assert.equal(proposals([field("What date are you available to start work?", { kind: "datepicker" })], profileSchema.parse({ ...profile, answers: [] }))[0]?.value, undefined);
});

// one employer's SuccessFactors asked three questions most
// forms ask in some wording, and each was left to the applicant; one saved
// answer now covers every wording.
test("essential job functions, military status and earlier interviews are answered from saved answers", () => {
  const applicant = profileSchema.parse({
    ...profile,
    answers: [
      { question: "Can you perform the essential job functions with or without reasonable accommodation?", answer: "Yes" },
      { question: "Military status", answer: "No" },
      { question: "Have you interviewed with this company before?", answer: "No" },
    ],
  });
  const ask = (label: string, options: string[] = []) =>
    proposals([field(label, { kind: options.length ? "select" : "combobox", options })], applicant)[0];
  assert.equal(ask("Are you able to perform the essential job functions for the position for which you are applying with or without reasonable accommodation?", ["Yes", "No"])?.value, "Yes");
  assert.equal(ask("Military Status", ["No Selection", "Active Guard", "Active Reserve", "No Military", "Not Indicated"])?.value, "No Military");
  assert.ok(ask("Military Status")?.choices?.includes("No Military"));
  assert.equal(ask("Are you serving, or have you ever served in the Armed Forces?", ["Yes", "No"])?.value, "No");
  assert.equal(ask("Have you ever interviewed with Alpha Energy, Beta Energy, or Gamma Energy before?", ["Yes", "No"])?.value, "No");
  // Without saved answers, nothing is assumed.
  assert.equal(proposals([field("Military Status", { kind: "combobox" })], profileSchema.parse({ ...profile, answers: [] }))[0]?.value, undefined);
});

// one employer's Ashby form: "Please indicate all of the locations
// that you would be interested in relocating to for this position", one box
// per city. Willing to relocate, every one is ticked; otherwise none is.
test("a relocation question listing its locations as boxes is answered from the relocation answer", () => {
  const asked = "Please indicate all of the locations that you would be interested in relocating to for this position.";
  const box = (label: string) => field(label, { kind: "checkbox", question: asked, options: ["Yes", "No"] });
  const willing = profileSchema.parse({ ...profile, answers: [{ question: "Are you willing to relocate?", answer: "Yes" }] });
  assert.deepEqual(proposals([box("New York, NY"), { ...box("San Francisco, CA"), id: "sf" }], willing).map((proposal) => proposal.value), ["Yes", "Yes"]);
  const staying = profileSchema.parse({ ...profile, answers: [{ question: "Are you willing to relocate?", answer: "No" }] });
  assert.deepEqual(proposals([box("New York, NY")], staying), []);
  assert.deepEqual(proposals([box("New York, NY")], profileSchema.parse({ ...profile, answers: [] })), []);
});

// one employer's JazzHR form: "What's your
// citizenship / employment eligibility?" lists statuses under each country,
// and "Are you available to work in the Greater Boston area for the duration
// of this internship?" asks the relocation question of one place.
test("a citizen picks their status from a list of eligibilities, and one willing to relocate is available where the job is", () => {
  const citizen = profileSchema.parse({ ...profile, workAuthorization: "US Citizen", answers: [{ question: "Are you willing to relocate?", answer: "Yes" }] });
  const eligibility = field("What's your citizenship / employment eligibility?", {
    id: "citizen",
    kind: "select",
    options: ["I am a U.S. Citizen/Permanent Resident", "Non-citizen allowed to work for any employer", "Non-citizen allowed to work for current employer", "Non-citizen seeking work authorization", "I am a Canadian Citizen/Permanent Resident", "Other"],
  });
  const boston = field("Are you available to work in the Greater Boston area for the duration of this internship?", { id: "boston", kind: "select", options: ["Yes", "No"] });
  assert.deepEqual(proposals([eligibility, boston], citizen).map((proposal) => [proposal.fieldId, proposal.value]), [
    ["citizen", "I am a U.S. Citizen/Permanent Resident"],
    ["boston", "Yes"],
  ]);
  // Nothing saved: nothing is said.
  assert.deepEqual(proposals([eligibility, boston], profile), []);
});

test("a minimum-GPA question is answered by comparing the saved GPA, on the same scale only", () => {
  // one employer's Oracle form.
  const yesNo = { kind: "radio" as const, options: ["Yes", "No"] };
  const asked = field("Do you meet the minimum GPA requirement of 3.0?", yesNo);
  assert.equal(proposals([asked], withGPA(profile, "3.84"))[0]?.value, "Yes");
  assert.equal(proposals([asked], withGPA(profile, "2.9"))[0]?.value, "No");
  assert.equal(proposals([field("Is your cumulative GPA 3.5 or higher?", yesNo)], withGPA(profile, "3.84"))[0]?.value, "Yes");
  assert.deepEqual(proposals([asked], profile), []);
  // Another scale is never compared with a four-point minimum: 8.7 of 10,
  // or a German 1.3 where lower is better.
  assert.deepEqual(proposals([asked], withGPA(profile, "8.7", "10")), []);
  assert.deepEqual(proposals([asked], withGPA(profile, "1.3", "other")), []);
  assert.deepEqual(proposals([asked], withGPA(profile, "3.84", "other")), []);
  // A question that states its own scale is compared on it.
  const tenPoint = field("Do you have a CGPA of at least 7.5 out of 10?", yesNo);
  assert.equal(proposals([tenPoint], withGPA(profile, "8.7", "10"))[0]?.value, "Yes");
  assert.deepEqual(proposals([tenPoint], withGPA(profile, "3.84")), []);
  // A Workday list, its options not read until opened (Lucerne): still a yes/no, never the GPA itself.
  assert.equal(proposals([field("Do you have a 3.0 gpa or higher?", { kind: "combobox", options: [] })], withGPA(profile, "3.84"))[0]?.value, "Yes");
});

test("a graduation date split in three after its question gets each part", () => {
  // one employer's Oracle form: each box got "May 2027" or "2027".
  const dated = { ...profile, education: [{ ...profile.education[0], endDate: "2099-12-13" }] };
  const part = (name: string) => proposals([field(`What is your expected year of graduation? ${name}`, { kind: "combobox" })], dated)[0]?.value;
  assert.equal(part("Month"), "December");
  assert.equal(part("Day"), "13");
  assert.equal(part("Year"), "2099");
  // Workday's parts carry their question with a colon.
  const workday = (name: string) => proposals([field(`What is your projected/approximate graduation date?: ${name}`, { kind: "text" })], dated)[0];
  assert.equal(workday("Month")?.value, "December");
  assert.ok(workday("Month")?.choices?.includes("12"));
  assert.equal(workday("Year")?.value, "2099");
  // After a sentence, and the 1st where the question says to use it: the profile holds only May 2027.
  const monthOnly = { ...profile, education: [{ ...profile.education[0], endDate: "2099-05" }] };
  const nested = (name: string) => proposals([field(`What is your (estimated or actual) graduation date? If you do not know your graduation day, input the first of the month.: ${name}`, { kind: "text" })], monthOnly)[0]?.value;
  assert.equal(nested("Month"), "May");
  assert.equal(nested("Day"), "1");
  assert.equal(nested("Year"), "2099");
});

test("Workday's degree codes and country-suffixed race options are matched", () => {
  // one employer's Workday and one employer's.
  assert.equal(pickListOption({ value: "Masters of Science", choices: degreeAliases("Masters of Science") },
    ["Master of Arts (M.A)", "Master of Science (M.S)", "Master of Business Administration (MBA)"], (option) => option), "Master of Science (M.S)");
  // one employer's: each degree explained in brackets.
  assert.equal(pickListOption({ value: "Masters of Science", choices: degreeAliases("Masters of Science") },
    ["Bachelors (±16 years of education)", "Masters (±18 years of education)", "Doctorate (over 19 years of education)"], (option) => option), "Masters (±18 years of education)");
  const race = proposals([field("What is your race / ethnicity?", { kind: "combobox" })], { ...profile, ethnicity: "South Asian" })[0];
  assert.equal(pickListOption(race!, ["Asian (Not Hispanic or Latino) (United States of America)", "White (Not Hispanic or Latino) (United States of America)"], (option) => option),
    "Asian (Not Hispanic or Latino) (United States of America)");
});

test("salary expectations are given for the period asked, in the applicant's currency only", () => {
  // one employer's Workday asked "What is your salary expectation?".
  const yearly = { ...profile, salary: { min: 95000, currency: "$", period: "year" as const } };
  const hourly = { ...profile, salary: { min: 35, currency: "", period: "hour" as const } };
  const answer = (label: string, saved: typeof profile, overrides: Partial<Field> = {}) => proposals([field(label, overrides)], saved)[0]?.value;
  assert.equal(answer("What is your salary expectation?", yearly), "$95,000");
  assert.equal(answer("Desired annual salary", yearly), "$95,000");
  // Pay is never converted between periods.
  assert.equal(answer("What is your expected hourly pay rate?", yearly), undefined);
  assert.equal(answer("What is your expected hourly pay rate?", hourly), "35");
  assert.equal(answer("What is your salary expectation?", hourly), "35 per hour");
  // A box that takes only a number gets the figure alone.
  assert.equal(answer("Desired salary (numbers only)", yearly), "95000");
  assert.equal(answer("What is your salary expectation?", yearly, { kind: "number" }), "95000");
  // A box the site refused the written figure in ("Invalid number.", Fabrikam's
  // SuccessFactors) gets the figure alone the next time.
  assert.equal(answer("What are your salary expectations?", yearly, { value: "$95,000", invalid: true }), "95000");
  // Accepted, it is left as it is.
  assert.equal(answer("What are your salary expectations?", yearly, { value: "$95,000" }), undefined);
  // Refused as the figure alone too, it is not written again.
  assert.equal(answer("What are your salary expectations?", yearly, { value: "95000", invalid: true }), undefined);
  // A range in euros stays in euros; none is added where none was given.
  const euros = { ...profile, salary: { min: 55000, max: 65000, currency: "EUR", period: "year" as const } };
  assert.equal(answer("What is your salary expectation?", euros), "EUR 55,000-65,000");
  assert.equal(answer("What is your salary expectation?", { ...profile, salary: { min: 55000, currency: "", period: "year" as const } }), "55,000");
  assert.deepEqual(proposals([field("Desired salary range", { kind: "select", options: ["$50k-$70k", "$70k-$90k"] })], yearly), []);
  const bracket = (options: string[], who = yearly) => answer("Desired salary range", who, { kind: "select", options });
  assert.equal(bracket(["$70k-$90k", "$90k-$99k", "$100k or more"]), "$90k-$99k");
  assert.equal(bracket(["EUR 50,000–69,999", "EUR 70,000–89,999"], euros), "EUR 50,000–69,999");
  assert.equal(bracket(["EUR 90,000–100,000", "EUR 100,001–120,000"], yearly), undefined);
  assert.equal(bracket(["$80k–$99k", "$100k or more"], { ...yearly, answers: [{ question: "Desired salary range", answer: "$100k or more" }] }), "$80k–$99k");
});

test("an application page's posting is guessed as the same address without /apply", () => {
  // one employer's Workable page.
  assert.equal(postingGuess("https://apply.workable.com/acme-dot-a-i/j/DE75CD20B8/apply"), "https://apply.workable.com/acme-dot-a-i/j/DE75CD20B8");
  assert.equal(postingGuess("https://jobs.lever.co/acme/f8c9ed26-4574-4ad2-954b-b7f5ec365495/apply?lever-source=x"), "https://jobs.lever.co/acme/f8c9ed26-4574-4ad2-954b-b7f5ec365495");
  assert.equal(postingGuess("https://jobs.ashbyhq.com/acme/1234/application"), "https://jobs.ashbyhq.com/acme/1234");
  // Microsoft's careers site applies at ?pid= and shows the job at /careers/job/<id>.
  assert.equal(postingGuess("https://apply.careers.microsoft.com/careers/apply?pid=1970393557049981"), "https://apply.careers.microsoft.com/careers/job/1970393557049981");
  assert.equal(postingGuess("https://example.com/careers/engineer"), undefined);
  assert.equal(postingGuess("https://example.com/apply"), undefined);
  // Paylocity's Apply page and its Details page.
  assert.equal(postingGuess("https://recruiting.paylocity.com/Recruiting/Jobs/Apply/1234567"), "https://recruiting.paylocity.com/Recruiting/Jobs/Details/1234567");
});

test("a LinkedIn or GitHub link asked as a request with instructions is still the profile's", () => {
  // one employer's Workday.
  const asked = field("Please provide your LinkedIn Profile url. Instruction: Navigate to your LinkedIn Profile page, copy the url and paste here.", { kind: "text" });
  assert.match(proposals([asked], { ...profile, linkedin: "linkedin.com/in/example" })[0]?.value || "", /linkedin\.com\/in\/example$/);
  // A question about an employer that asks for something else is not the link.
  assert.deepEqual(proposals([field("How did you hear about us on LinkedIn?", { kind: "text" })], { ...profile, linkedin: "linkedin.com/in/example" }).map((p) => p.value).filter((v) => /linkedin\.com/.test(v)), []);
});

// one employer's Workday: "interns must be
// actively enrolled in a … degree-seeking program … If you qualify, please
// select yes." was left for an applicant midway through a master's.
test("a current student answers Yes to being enrolled, and nobody else is answered for", () => {
  const now = new Date();
  const ym = (months: number) => {
    const date = new Date(now.getFullYear(), now.getMonth() + months, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  };
  const row = (startDate: string, endDate: string) => ({ organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate, endDate, location: "", details: "" });
  const student = profileSchema.parse({ ...profile, education: [row(ym(-14), ym(8))] });
  const graduate = profileSchema.parse({ ...profile, education: [row(ym(-40), ym(-3))] });
  const justStarted = profileSchema.parse({ ...profile, education: [row(ym(-1), ym(20))] });
  const label = "To qualify for our program, interns must be actively enrolled in a bachelor’s, master’s, or other degree-seeking program at an accredited college or university, with a focus in a relevant field. Students must have completed at least one semester of coursework. Students who will be graduating in Spring 2027 will also be considered.  If you qualify, please select yes.";
  const pick = (who: typeof student, text = label, overrides: Partial<Field> = { kind: "combobox", options: ["Yes", "No"] }) => proposals([field(text, overrides)], who)[0]?.value;
  assert.equal(pick(student), "Yes");
  // A list read only when opened still gets its answer.
  assert.equal(pick(student, label, { kind: "combobox", options: [] }), "Yes");
  assert.equal(pick(student, "Are you currently enrolled in a degree program?"), "Yes");
  assert.equal(pick(graduate), undefined);
  assert.equal(pick(justStarted), undefined);
  // Which school is another question, answered with the school, not Yes.
  assert.equal(pick(student, "Please include the university you are currently enrolled in", { kind: "text" }), "Michigan State University");
});

// one employer's Workday: a U.S. citizen was asked whether they hold
// temporary authorization (OPT, CPT) and, if on OPT, whether they could
// extend it, and both were left. A citizen holds none and is not on OPT;
// anyone else is left to answer.
test("OPT and CPT questions are answered for a citizen and left for anyone else", () => {
  const ask = (label: string, options: string[], who: Parameters<typeof proposals>[1]) =>
    proposals([field(label, { kind: "combobox", options })], who)[0]?.value;
  const citizen = profileSchema.parse({ ...profile, workAuthorization: [{ country: "US", status: "citizen", needsSponsorship: false }] });
  const student = profileSchema.parse({ ...profile, workAuthorization: [{ country: "US", status: "visa", needsSponsorship: true }] });
  const temporary = "Do you have temporary authorization (e.g., OPT, CPT, or similar temporary work authorization) to currently work in the United States?";
  const extension = "If you are currently in a period of Optional Practical Training (OPT), are you eligible for a 24-month OPT extension based upon a degree from a qualifying United States institution in Science, Technology, Engineering or Mathematics (STEM)?";
  assert.equal(ask(temporary, ["Yes", "No"], citizen), "No");
  assert.equal(ask(extension, ["Yes", "No", "N/A"], citizen), "N/A");
  assert.equal(ask("Are you currently in a period of Optional Practical Training (OPT)?", [], citizen), "No");
  // No "N/A" to say it with: a No would read as ineligible.
  assert.equal(ask(extension, ["Yes", "No"], citizen), undefined);
  assert.equal(ask(temporary, ["Yes", "No"], student), undefined);
  assert.equal(ask(extension, ["Yes", "No", "N/A"], student), undefined);
});

// one employer's Workday: "I am a veteran but do not
// fall under the protected classifications" was chosen for someone who never
// served, and "I have no military experience" read as a veteran's answer.
test("a veteran list that words service apart is answered by the saved military answer", () => {
  const options = ["I am a Protected Veteran (as defined above)", "I am a veteran but do not fall under the protected classifications listed above", "I have no military experience", "I do not wish to disclose my status"];
  const ask = (military: string | undefined) =>
    proposals([field("Please select your Veteran status.", { kind: "combobox", options })], profileSchema.parse({
      ...profile,
      veteranStatus: "No",
      answers: military ? [{ question: "Military status", answer: military }] : [],
    }))[0]?.value;
  assert.equal(ask("No"), "I have no military experience");
  assert.equal(ask("Yes"), "I am a veteran but do not fall under the protected classifications listed above");
  // Not known whether they served: neither is said for them.
  assert.equal(ask(undefined), undefined);
  assert.equal(canonicalAnswer("veteranStatus", "I have no military experience"), "No");
});

// Oracle's Veteran Status loads its options only when opened: the rule
// proposed nothing, and the model typed "I am not a veteran", which none of
// "Not a Protected Veteran", "Not disclosed" and "Protected Veteran" is.
test("a veteran list whose options load when it opens gets the answer in the wordings lists use", () => {
  const options = ["Not a Protected Veteran", "Not disclosed", "Protected Veteran"];
  const ask = (veteranStatus: string, military?: string) => {
    const proposal = proposals([field("Veteran Status", { kind: "combobox", options: [] })], profileSchema.parse({
      ...profile,
      veteranStatus,
      answers: military ? [{ question: "Military status", answer: military }] : [],
    }))[0];
    return proposal && pickListOption(proposal, options, (option) => option);
  };
  assert.equal(ask("I am not a veteran", "No"), "Not a Protected Veteran");
  assert.equal(ask("No"), "Not a Protected Veteran");
  assert.equal(ask("Yes"), "Protected Veteran");
  assert.equal(ask("Decline to answer"), "Not disclosed");
});

// A Greenhouse react-select "Are you a veteran or active member of the United
// States Armed Forces? (select one)" lists its options only when opened; the
// saved "I am not a veteran" matched none of its Yes/No options.
test("Oracle's veteran category and Hispanic boxes are answered No as they stand, and its discharge date lists are no veteran question", () => {
  const saved = profileSchema.parse({ ...profile, veteranStatus: "I am not a veteran", hispanic: "No", ethnicity: "South Asian" });
  const box = (label: string) => field(label, { kind: "checkbox", options: ["Yes", "No"] });
  for (const label of ["Disabled Veteran", "Recently Separated Veteran", "Armed Forces Service Medal Veteran", "Active Duty Wartime or Campaign Badge Veterans", "I am Hispanic or Latino."])
    assert.equal(untickedNo(box(label), saved), true, label);
  assert.equal(untickedNo({ ...box("Disabled Veteran"), value: "Yes" }, saved), false);
  for (const part of ["Month", "Day", "Year"])
    assert.deepEqual(proposals([field(`Newly Separated Veteran Discharge Date ${part}`, { kind: "combobox", options: [] })], saved), []);
});

// A race list whose label is the whole equal-opportunity preamble: it says the
// employer does not discriminate "on the basis of race, religion, color…".
// The religion named there was read as a non-U.S. religion question and the
// list was left to the AI step.
// iCIMS draws its phone as a "Phones (1)" section holding a Type list and a box
// named only "Number"; the number the site had saved stayed.
test("a Phones section's box named only Number gets the profile's phone", () => {
  const saved = profileSchema.parse({ ...profile, phone: "5405550100" });
  const number = { ...field("Number", { kind: "text" }), section: "Phones" };
  assert.equal(proposals([number], saved)[0]?.value, "5405550100");
  // A Number anywhere else is not the phone.
  assert.deepEqual(proposals([{ ...field("Number", { kind: "text" }), section: "Addresses" }], saved), []);
});

test("a race list under an equal-opportunity statement that names religion among its grounds gets the race", () => {
  const saved = profileSchema.parse({ ...profile, ethnicity: "South Asian" });
  const label = "If you are applying for a job outside of U.S. and do not wish to participate, please select Decline to Self-Identify. Providing this information is voluntary. Acme is an Equal Opportunity Employer and does not discriminate in hiring or employment against any individual on the basis of race, religion, color, creed, gender, national origin, age, veteran status, or disability.";
  const options = ["American Indian or Alaska Native", "Asian", "Black or African American", "Hispanic or Latino", "I do not wish to self identify", "White"];
  assert.equal(proposals([field(label, { kind: "combobox", options })], saved)[0]?.value, "Asian");
  // A religion question itself is still left.
  assert.deepEqual(proposals([field("What is your religion or belief?", { kind: "combobox", options: ["Christian", "Hindu", "Muslim", "No religion"] })], saved), []);
});

test("a veteran Yes/No list whose options load when it opens gets No for a saved not-a-veteran", () => {
  const options = ["Yes", "No", "I don't wish to answer"];
  const label = "Are you a veteran or active member of the United States Armed Forces? (select one)";
  const proposal = proposals([field(label, { kind: "combobox", options: [] })], profileSchema.parse({
    ...profile,
    veteranStatus: "I am not a veteran",
    answers: [{ question: "Military status", answer: "No" }],
  }))[0];
  assert.ok(proposal, "a proposal for the veteran list");
  assert.equal(pickListOption(proposal, options, (option) => option), "No");
  const worded = ["Yes, I am a veteran or active member", "No, I am not a veteran or active member", "I prefer to self-describe", "I don't wish to answer"];
  assert.equal(pickListOption(proposal, worded, (option) => option), "No, I am not a veteran or active member");
  // Not known whether they served: nothing is said for them.
  const unknown = proposals([field(label, { kind: "combobox", options: [] })], profileSchema.parse({ ...profile, veteranStatus: "I am not a veteran" }))[0];
  assert.equal(unknown && pickListOption(unknown, options, (option) => option), undefined);
});

// A self-disclosure page names its lists by id only: "…-gender-dropdown",
// "…-ethnicity-dropdown" and "…-veteranstatus-dropdown", options drawn when
// opened. Gender and race were read from the id; "veteranstatus", one word,
// was not, and the veteran list was left empty.
test("a veteran list named only by an id with 'veteranstatus' in it takes the answer", () => {
  const options = ["I identify as one or more of the classifications of the protected veteran", "I am not a protected veteran", "I choose not to disclose"];
  const proposal = proposals([field("selfdisclosure-veteranstatus-dropdown", { kind: "combobox", options: [] })], profileSchema.parse({ ...profile, veteranStatus: "I am not a protected veteran" }))[0];
  assert.ok(proposal, "a proposal for the veteran list");
  assert.equal(pickListOption(proposal, options, (option) => option), "I am not a protected veteran");
});

// A JazzHR page asks "Are you a U.S Citizen?" and the sponsorship question
// with a Yes box and a No box under each: the box whose label answers the
// question is ticked, the other left, a saved answer worded as the question
// included.
test("a Yes box and a No box under one question: the box naming the answer is ticked", () => {
  // The citizenship answer saved in the applicant's own words, as asked.
  const applicant = profileSchema.parse({ ...profile, country: "US", citizenships: ["US"], workAuthorization: [{ country: "US", status: "citizen", needsSponsorship: false }],
    answers: [{ question: "Are you a U.S. citizen?", answer: "Yes" }] });
  const box = (question: string, label: string) =>
    proposals([field(label, { kind: "checkbox", question, options: ["Yes", "No"] })], applicant)[0]?.value;
  assert.equal(box("Are you a U.S Citizen?", "Yes"), "Yes");
  assert.equal(box("Are you a U.S Citizen?", "No"), undefined);
  assert.equal(box("Do you now or will you in the future require sponsorship to work in the US?", "Yes"), undefined);
  assert.equal(box("Do you now or will you in the future require sponsorship to work in the US?", "No"), "Yes");
});

// A SmartRecruiters screening page: its graduation month list
// holds only months, its past-employment list says No as "Not Applicable",
// and the date box after it asks for the details, not Yes or No.
test("a months-only list takes the month, a list without No takes Not Applicable, and a details box after a past-employer question is left", () => {
  const applicant = profileSchema.parse({ ...profile, neverWorkedForApplyingCompanies: true, applyingTo: { company: "Acme", title: "Engineer Intern" }, education: [{ organization: "Penn State", title: "Masters of Science", startDate: "2025-08-21", endDate: "2099-12-13" }] });
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const answer = (label: string, overrides: Partial<Field> = {}) => proposals([field(label, overrides)], applicant)[0];
  const listed = (label: string, options: string[]) => {
    const proposal = answer(label, { kind: "combobox", options });
    return proposal && pickListOption(proposal, options, (option) => option);
  };
  assert.equal(listed("Please select your Graduation Month", months), "December");
  assert.equal(listed("Do you currently or have you previously worked at Acme in any capacity? (Select all that apply)", ["Not Applicable", "I currently work at Acme", "I previously worked at Acme"]), "Not Applicable");
  assert.equal(answer("If you have previously worked at Acme, please provide your approximate last date of employment.(MM/DD/YYYY)"), undefined);
});

// The same page's degree type list and its "Today's Date" box beside the
// typed name were left unanswered.
test("a degree type list takes the degree under way, and a Today's Date box today's date", () => {
  const applicant = profileSchema.parse({ ...profile, education: [
    { organization: "Virginia Tech", title: "Bachelor of Science", startDate: "2018-08-20", endDate: "2022-05-10" },
    { organization: "Penn State", title: "Masters of Science", startDate: "2025-08-21", endDate: "2099-12-13" },
  ] });
  const answer = (label: string, overrides: Partial<Field> = {}) => proposals([field(label, overrides)], applicant)[0]?.value;
  assert.equal(answer("Please select your degree type", { kind: "combobox", options: ["BA/BS", "Masters", "PhD", "N/A"] }), "Masters");
  const today = new Date();
  assert.equal(answer("Today's Date"), `${String(today.getMonth() + 1).padStart(2, "0")}/${String(today.getDate()).padStart(2, "0")}/${today.getFullYear()}`);
  // An Ashby "Application Date" calendar: the day it is filled (report d27d766a).
  assert.ok(answer("Application Date", { kind: "datepicker" }), "Application Date left empty");
  assert.match(answer("Application Date", { kind: "datepicker" })!, new RegExp(`${today.getFullYear()}`));
});

// one employer's Race/Ethnicity: its label defines each category
// after its name, "Hispanic or Latino" first, and names places ("China,
// India, Japan") the U.S. definitions use. It was read as the Hispanic
// question, then as another country's, and left.
test("a race list whose label carries the U.S. category definitions takes the race", () => {
  const applicant = profileSchema.parse({ ...profile, ethnicity: "South Asian", hispanic: "No" });
  const label = "Race/Ethnicity Race categories are defined as follows: Hispanic or Latino - A person of Cuban, Mexican, Puerto Rican, South or Central American, or other Spanish culture or origin regardless of race White (Not Hispanic or Latino) - A person having origins in any of the original peoples of Europe, the Middle East, or North Africa Asian (Not Hispanic or Latino) - A person having origins in any of the original peoples of the Far East, Southeast Asia, or the Indian Subcontinent, including, for example, Cambodia, China, India, Japan, Korea, Malaysia, Pakistan, the Philippine Islands, Thailand, and Vietnam American Indian or Alaska Native (Not Hispanic or Latino) - A person having origins in any of the original peoples of North and South America Two or More Races (Not Hispanic or Latino) - All persons who identify with more than one of the above five races";
  const options = ["Hispanic or Latino", "American Indian or Alaska Native (Not Hispanic or Latino)", "Asian (Not Hispanic or Latino)", "White (Not Hispanic or Latino)", "Two or More Races (Not Hispanic or Latino)", "I prefer not to specify"];
  assert.equal(proposals([field(label, { kind: "combobox", options })], applicant)[0]?.value, "Asian (Not Hispanic or Latino)");
  // Still the Hispanic question when it is asked first.
  assert.equal(proposals([field("Are you Hispanic or Latino?", { kind: "select", options: ["Yes", "No"] })], applicant)[0]?.value, "No");
});

// A SmartRecruiters pass types and picks each title, company, school and
// place with real keys: at 60 s it was cut off in the second school
//. It gets the time Workday's does.
test("a site rule's pass gets the longer time on sites whose picks are slow", () => {
  assert.equal(configPassTimeout("jobs.smartrecruiters.com"), 150_000);
  assert.equal(configPassTimeout("acme.wd1.myworkdayjobs.com"), 150_000);
  assert.equal(configPassTimeout("acme.fa.us2.oraclecloud.com"), 240_000);
  assert.equal(configPassTimeout("jobs.lever.co"), 60_000);
});

// an employer: "Are you related or have close
// personal friendships with any current an employer employees…" was left at No
// Selection. As with a referral: none of the applicant's references or jobs
// there, No; one there, theirs to say.
test("a related-to-an-employee question is No unless a reference or a job is at the company", () => {
  const label = "Are you related or have close personal friendships with any current Acme employees with whom you will be directly working with if hired?";
  const options = ["No", "Unknown", "Yes"];
  const ask = (who: typeof profile) => proposals([field(label, { kind: "combobox", options })], who)[0]?.value;
  assert.equal(ask(profileSchema.parse({ ...profile, applyingTo: { company: "Acme", title: "Intern" } })), "No");
  assert.equal(ask(profileSchema.parse({ ...profile, references: [{ name: "Sam Lee", relationship: "Manager at Acme", email: "sam@acme.example" }] })), undefined);
});

// Microsoft: "Are you currently enrolled in a Doctorate Degree
// program in Computer Science…?" was answered Yes for a master's student.
// A question naming a level asks about that level.
test("an enrollment question naming a degree level is answered for that level", () => {
  const applicant = profileSchema.parse({ ...profile, education: [
    { organization: "Virginia Tech", title: "Bachelor of Science", startDate: "2018-08", endDate: "2022-05" },
    { organization: "Penn State", title: "Master of Science", startDate: "2025-08", endDate: "2099-12" },
  ] });
  const ask = (label: string) => proposals([field(label, { kind: "combobox", options: ["Yes", "No"] })], applicant)[0]?.value;
  assert.equal(ask("Are you currently enrolled in a Doctorate Degree program in Computer Science, Operations Research or a related STEM field?"), "No");
  assert.equal(ask("Are you currently enrolled in a Master's degree program?"), "Yes");
  assert.equal(ask("Are you currently enrolled in a Bachelor's degree program?"), "No");
});

// an employer and an employer on Greenhouse: "1–2 years" with its unit
// read as no option for one year; "Yes, I am currently based in Atlanta, GA"
// was taken for an applicant elsewhere who will relocate; "What is your
// Legal Name?" was left.
test("a range with its unit, the relocating Yes, and a legal name asked as a question are answered", () => {
  const applicant = profileSchema.parse({ ...profile, city: "Phoenix", willingToRelocate: "Yes", work: [{ organization: "Acme", title: "Data Analyst", startDate: "2024-06", endDate: "2025-08", details: "" }] });
  const pick = (label: string, options: string[]) => {
    const answer = proposals([field(label, { kind: "combobox", options })], applicant)[0];
    return answer && pickListOption(answer, options, (option) => option);
  };
  assert.equal(pickListOption({ value: "1", numeric: 1 }, ["Less than 1 year", "1–2 years", "3–4 years", "5+ years"], (option) => option), "1–2 years");
  assert.equal(pickListOption({ value: "6", numeric: 6 }, ["Less than 1 year", "1–2 years", "3–4 years", "5+ years"], (option) => option), "5+ years");
  assert.equal(pick("This role is hybrid and requires working from our Atlanta, GA office. Are you currently located in Atlanta or willing to relocate prior to your start date?", ["Yes, I am currently based in Atlanta, GA", "Yes, I am willing to relocate at my own expense", "No, I am not willing to relocate"]), "Yes, I am willing to relocate at my own expense");
  assert.equal(proposals([field("What is your Legal Name?")], applicant)[0]?.value, `${profile.firstName} ${profile.lastName}`);
});

// one employer's iCIMS screening page: years with one
// skill or kind of work are never more than all the applicant's work, so a
// "less than N years" choice is answered when all of it is under N, and
// nothing else is guessed.
test("a skill's years take a list's 'less than' choice only when all work is under it", () => {
  // Eighteen months of work, up to now.
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() - 17);
  const worked = profileSchema.parse({
    ...profile,
    work: [{ organization: "Example Labs", title: "Engineer", location: "Lansing, MI", startDate: start.toISOString().slice(0, 10), endDate: "", details: "" }],
  });
  const hpc = field("How many years of experience do you have designing HPC, AI, or large-scale compute infrastructure?", {
    kind: "select", options: ["Less than 2 years", "2-5 years", "5-8 years", "8-12 years", "12+ years"],
  });
  assert.equal(proposals([hpc], worked)[0]?.value, "Less than 2 years");
  const cpp = field("Please select the # of years of professional work experience with the following: C/C++", {
    kind: "select", options: ["I have less than 1 year with this skill", "1-2 years", "3-5 years", "6-8 years", "more than 8 years"],
  });
  // Over a year of work in all: under one year with C/C++ is not known.
  assert.deepEqual(proposals([cpp], worked), []);
  // Two years exactly is not under two.
  const two = new Date();
  two.setUTCDate(1);
  two.setUTCMonth(two.getUTCMonth() - 23);
  const longer = profileSchema.parse({ ...worked, work: [{ ...worked.work[0], startDate: two.toISOString().slice(0, 10) }] });
  assert.deepEqual(proposals([hpc], longer), []);
  const fresh = profileSchema.parse({
    ...profile,
    work: [{ organization: "Example Labs", title: "Intern", location: "Lansing, MI", startDate: "2023-07-01", endDate: "2023-09-01", details: "" }],
  });
  assert.equal(proposals([cpp], fresh)[0]?.value, "I have less than 1 year with this skill");
});

// an employer: asked where the applicant
// would move from, the relocation question's "Yes" was given.
test("a question asking the city, state and zip one would move from gets the applicant's place", () => {
  // As the applicant's: willing to relocate, which answered it before.
  const placed = profileSchema.parse({ ...profile, city: "Lansing", state: "Michigan", postalCode: "48910", willingToRelocate: "Yes" });
  const asked = field("Relocation assistance may be available for this role. If you would need to relocate, please tell us the city, state, and zip code you’d be moving from", { kind: "textarea" });
  assert.equal(proposals([asked], placed)[0]?.value, "Lansing, Michigan 48910");
});

// one employer's Workday questions: the highest degree asked after a
// preamble naming "your most recent graduation date" was given that date,
// and "Expected degree completion date" was left.
test("a highest-degree question after a preamble, and an expected completion date, are answered", () => {
  const studying = profileSchema.parse({
    ...profile,
    education: [
      { organization: "Michigan State University", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08-19", endDate: "2099-05-10", location: "", details: "" },
      { organization: "Penn State", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2020-09-13", endDate: "2024-06-15", location: "", details: "" },
    ],
  });
  const highest = field("4. If hired by Acme, we will verify your most recent graduation date and the highest degree or diploma received. What is the highest level of education you've received?", { kind: "combobox" });
  assert.match(proposals([highest], studying)[0]?.value || "", /^Bachelor/);
  const part = (name: string) => proposals([field(`5a. Expected degree completion date.: ${name}`, { kind: "spinbutton" })], studying)[0]?.value;
  assert.equal(part("Month"), "May");
  assert.equal(part("Day"), "10");
  assert.equal(part("Year"), "2099");
});

// an employer: "Did you obtain this degree in the
// last 24 months?" after the highest degree received: that degree's end.
test("a degree obtained within so many months is read from the highest finished degree's end", () => {
  const ago = (months: number) => {
    const at = new Date();
    at.setUTCDate(1);
    at.setUTCMonth(at.getUTCMonth() - months);
    return at.toISOString().slice(0, 10);
  };
  const graduated = (end: string) => profileSchema.parse({
    ...profile,
    education: [
      { organization: "Michigan State University", title: "Master of Science", startDate: "2025-08-19", endDate: "2099-05-10", location: "", details: "" },
      { organization: "Penn State", title: "Bachelor of Science", startDate: "2020-09-13", endDate: end, location: "", details: "" },
    ],
  });
  const asked = field("4a. Did you obtain this degree in the last 24 months?", { kind: "combobox" });
  assert.equal(proposals([asked], graduated(ago(29)))[0]?.value, "No");
  assert.equal(proposals([asked], graduated(ago(10)))[0]?.value, "Yes");
});

// Litware's iCIMS form: "Did you complete the
// most recent degree listed, and receive notice of your graduation?" was
// left. The latest school row says: still studying is No, finished is Yes.
test("whether the most recent degree was completed is read from the latest school row", () => {
  const asked = field("Did you complete the most recent degree listed, and receive notice of your graduation?", { kind: "combobox", options: ["Yes", "No"], section: "Education" });
  const studying = profileSchema.parse({
    ...profile,
    education: [
      { organization: "Virginia Tech", title: "Master of Science", startDate: "2025-08-21", endDate: "2099-05-10", current: true, location: "", details: "" },
      { organization: "Penn State", title: "Bachelor of Science", startDate: "2020-09-13", endDate: "2024-06-15", location: "", details: "" },
    ],
  });
  assert.equal(proposals([asked], studying)[0]?.value, "No");
  const finished = profileSchema.parse({ ...profile, education: [studying.education[1]] });
  assert.equal(proposals([asked], finished)[0]?.value, "Yes");
  // A row with no end date says nothing.
  const unknown = profileSchema.parse({ ...profile, education: [{ ...studying.education[1], endDate: "" }] });
  assert.equal(proposals([asked], unknown)[0]?.value, undefined);
});

// one employer's Greenhouse form: its sanctions
// list had "Ordinarily a resident of Russia or Belarus and not willing to
// relocate…" ticked as a relocation answer, and its follow-up's "U.S.
// citizen" as citizenship. Read as what they ask, an applicant tied to no
// sanctioned place has "None of the above" and then "Not applicable".
test("a sanctions list and its follow-up are answered as what they ask", () => {
  const american = profileSchema.parse({ ...profile, country: "United States", citizenships: ["US"], willingToRelocate: "Yes" });
  const sanctions = "Please confirm whether any of the below applies to you. Select all that apply. Note: This information will only be used to ensure compliance with U.S. sanctions and export controls.";
  const followUp = "If you selected a response to the prior question other than “none of the above,” please confirm whether any of the following also applies to you. Select all that apply.";
  const box = (question: string, option: string) => field(`${question}: ${option}`, { kind: "checkbox", question, required: false });
  const ticked = (question: string, option: string, who = american) => proposals([box(question, option)], who)[0]?.value;
  // A box ticked before (by an earlier fill or the site) is cleared; an
  // empty one is left empty.
  const clears = (question: string, option: string) =>
    proposals([{ ...box(question, option), value: "Yes", siteValue: true }], american)[0]?.value;
  assert.equal(clears(sanctions, "Ordinarily a resident of Russia or Belarus and not willing to relocate for an Acme role"), "No");
  assert.equal(ticked(sanctions, "Citizen or permanent resident of Cuba, Iran, North Korea, or Syria"), undefined);
  assert.equal(ticked(sanctions, "None of the above"), "Yes");
  assert.equal(clears(followUp, "U.S. citizen"), "No");
  assert.equal(ticked(followUp, "Not applicable (i.e., I selected “none of the above” for the prior question)"), "Yes");
  // A tie to a sanctioned place, or no citizenship saved: the applicant's.
  const tied = profileSchema.parse({ ...american, citizenships: ["US", "RU"] });
  assert.equal(ticked(sanctions, "None of the above", tied), undefined);
  assert.equal(ticked(sanctions, "None of the above", profileSchema.parse({ ...american, citizenships: [] })), undefined);
});

// How the applicant heard of an opening: their own sources, else
// Application Lane, under a list's Other and typed in the box beside it.
test("a how-did-you-hear question gets the applicant's source, else Application Lane under Other", () => {
  const none = profileSchema.parse({ ...profile, referralSource: [] });
  const list = field("How did you hear about this opportunity?", { kind: "select", options: ["LinkedIn", "Company website", "Job board", "Other"] });
  // The list has no Application Lane: its Other.
  assert.equal(proposals([list], none)[0]?.value, "Other");
  assert.equal(proposals([field("How did you hear about us?", { kind: "text" })], none)[0]?.value, "Application Lane");
  // The box beside the list, once it says Other.
  const specify = field("If other, please specify", { kind: "text" });
  assert.equal(proposals([{ ...list, value: "Other" }, specify], none).find((p) => p.fieldId === specify.id)?.value, "Application Lane");
  assert.equal(proposals([{ ...list, value: "LinkedIn" }, specify], none).find((p) => p.fieldId === specify.id), undefined);
  // A source of the applicant's own comes first.
  const own = profileSchema.parse({ ...profile, referralSource: ["LinkedIn"] });
  assert.equal(proposals([list], own)[0]?.value, "LinkedIn");
  // A referral question is another question.
  assert.equal(proposals([field("Who referred you?", { kind: "text" })], none)[0]?.value, undefined);
  // Its details box asked among the list's other choices (one employer's
  // Ashby).
  const details = field("If \"Industry Conference\" or \"Other,\" please provide more details", { kind: "textarea" });
  assert.equal(proposals([{ ...list, value: "Other" }, details], none).find((p) => p.fieldId === details.id)?.value, "Application Lane");
  // A box that says it is for a source the list above lacks, its list
  // unnamed on the page (TikTok).
  const elsewhere = field("Where else did you hear about this opportunity, that is not listed above as an option?", { kind: "text" });
  assert.equal(proposals([elsewhere], none)[0]?.value, "Application Lane");
  // Asked as a request (Fabrikam's SuccessFactors): a list that
  // loads when opened.
  const request = proposals([field("Please tell us how you heard about this position.", { kind: "combobox" })], none)[0]!;
  assert.equal(request.value, "Application Lane");
  assert.ok(request.choices?.includes("Other"));
});

// Fabrikam's SuccessFactors job rows: "Summary of Work Performed"
// kept the site's resume parser's text over the profile's own.
test("a job row's Summary of Work Performed is the profile's description of it", () => {
  const worker = profileSchema.parse({ ...profile, work: [{ organization: "Acme", title: "Intern", startDate: "2023-07", endDate: "2023-09", location: "", details: "Built REST APIs for Acme's billing team." }] });
  const summary = field("Summary of Work Performed", { kind: "textarea", section: "Previous Employment", index: 0, value: "Parser's own words", siteValue: true });
  assert.equal(proposals([summary], worker)[0]?.value, "Built REST APIs for Acme's billing team.");
});

// Fabrikam's SuccessFactors job rows: a bare "Start Date" whose
// section was not yet read was answered as an availability date, today's.
test("a bare Start Date beside End Date boxes is a row's date, not when one could start", () => {
  const ready = profileSchema.parse({ ...profile, answers: [...profile.answers, { question: "When can you start?", answer: "Immediately" }] });
  const start = field("Start Date", { id: "start", kind: "datepicker", value: "07/03/2023", siteValue: true });
  const end = field("End Date", { id: "end", kind: "datepicker", value: "09/08/2023" });
  assert.equal(proposals([start, end], ready).find((p) => p.fieldId === "start"), undefined);
});

// one employer's Workday questions: "If you answered
// "Yes" to question 1, please provide your permanent address…" was left,
// question 1 ("Are you currently enrolled…?") being Yes.
test("an address asked after a Yes to question 1 is the applicant's, and N/A after a No", () => {
  const home = profileSchema.parse({ ...profile, address: "100 Main St", addressLine2: "Apt 4", city: "Blacksburg", state: "VA", postalCode: "24060", country: "United States" });
  const q1 = (value: string) => field("Are you currently enrolled in a degree seeking program?", { id: "q1", kind: "radio", options: ["Yes", "No"], value });
  const q2 = field("What is your Current Degree Program?", { id: "q2", kind: "select", options: ["Bachelors", "Masters"], value: "Masters" });
  const address = field("If you answered \"Yes\" to question 1, please provide your permanent address. If you did not answer \"Yes\", please enter \"N/A\".", { id: "addr", kind: "textarea" });
  const answer = (value: string) => proposals([field("Language", { id: "lang", kind: "select", value: "English" }), q1(value), q2, address], home).find((p) => p.fieldId === "addr")?.value;
  assert.equal(answer("Yes"), "100 Main St, Apt 4, Blacksburg, VA 24060, United States");
  assert.equal(answer("No"), "N/A");
  assert.equal(answer(""), undefined);
  // The major asked the same way: the program under way.
  const studying = profileSchema.parse({ ...home, education: [
    { organization: "Virginia Tech", title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2018-08", endDate: "2022-05", location: "", details: "" },
    { organization: "Penn State", title: "Master of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2099-05", location: "", details: "" },
  ] });
  const major = field("If you answered \"Yes\" to question 1, please provide your major. If you did not answer \"Yes\", please enter \"N/A\".", { id: "major", kind: "text" });
  const majorFor = (value: string) => proposals([q1(value), q2, major], studying).find((p) => p.fieldId === "major")?.value;
  assert.equal(majorFor("Yes"), "Data Science");
  assert.equal(majorFor("No"), "N/A");
  // A list of majors joined by slashes takes a short form.
  const listed = { ...major, kind: "combobox" };
  const program = profileSchema.parse({ ...studying, education: [studying.education[0], { ...studying.education[1], fieldOfStudy: "M.S. Data Science, Analytics & Engineering (Applied Track)" }] });
  const said = proposals([q1("Yes"), q2, listed], program).find((p) => p.fieldId === "major");
  assert.equal(pickListOption(said!, ["N/A", "Computer Science", "Data Science/Analytics", "OTHER"], (option) => option), "Data Science/Analytics");
});

// Where the applicant hears about jobs is a site or board; references are the
// people a recruiter may contact. A reference's name saved among the sources
// (the box once read "Referral sources") is dropped, and neither answers
// "Who referred you?".
test("references' names are not sources of how the applicant heard of a job", () => {
  const saved = profileSchema.parse({
    ...profile,
    references: [{ name: "Jordan Park", relationship: "Manager", company: "Contoso", email: "jordan@example.test", phone: "" }],
    referralSource: ["Jordan Park", "LinkedIn"],
  });
  assert.deepEqual(saved.referralSource, ["LinkedIn"]);
  const onlyPeople = profileSchema.parse({ ...saved, referralSource: ["jordan park"] });
  assert.deepEqual(onlyPeople.referralSource, []);
  const list = field("How did you hear about this opportunity?", { kind: "select", options: ["LinkedIn", "Employee referral", "Other"] });
  assert.equal(proposals([list], onlyPeople)[0]?.value, "Other");
  assert.equal(proposals([field("Who referred you?", { kind: "text" })], onlyPeople)[0]?.value, undefined);
  // The AI fallback is shown the sources for a how-did-you-hear question,
  // not for a referral one.
  const sources = (label: string) => fieldFallbackSources(saved, [field(label, { kind: "text" })]).map((source) => source.id);
  assert.ok(sources("How did you hear about us?").includes("profile.referralSource"));
  assert.ok(!sources("Employee referral name").includes("profile.referralSource"));
});

// one employer's SmartRecruiters screening step: the degree month asked as "the month in which you will
// receive your degree", 30 credit hours by a bachelor's graduate, and a
// "Current or Former … Intern or Page" question.
test("degree month, credit hours and former-intern questions on a screening step are answered", () => {
  const months = ["Already graduated", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const studying = profileSchema.parse({
    ...profile,
    neverWorkedForApplyingCompanies: true,
    applyingTo: { company: "Contoso" },
    education: [
      { organization: "Virginia Tech", title: "Bachelor of Science", startDate: "2018-08", endDate: "2022-05", location: "", details: "" },
      { organization: "Penn State", title: "Master of Science", startDate: "2025-08", endDate: "2099-05-15", location: "", details: "" },
    ],
  });
  const month = field("Please indicate the month in which you will receive your degree (Associates, Bachelors, Masters, etc.) which you are currently pursuing.", { kind: "combobox", options: months });
  assert.equal(proposals([month], studying)[0]?.value, "May");
  const credits = field("Will you have completed 30 college credit hours at the time of the internship term for which you are applying?", { kind: "radio", options: ["Yes", "No"] });
  assert.equal(proposals([credits], studying)[0]?.value, "Yes");
  // No finished bachelor's degree: left to the applicant.
  assert.equal(proposals([credits], profileSchema.parse({ ...studying, education: [studying.education[1]] }))[0]?.value, undefined);
  const intern = field("As of the submission date of this application, are you a Current or Former Contoso Intern or Page?", { kind: "combobox", options: ["Yes", "No"] });
  assert.equal(proposals([intern], studying)[0]?.value, "No");
});

// one employer's SmartRecruiters language pair: a box for
// a language the applicant speaks, then its level.
test("a typed-in language and its level come from the profile's languages", () => {
  const speaker = profileSchema.parse({ ...profile, languages: ["English: Native"] });
  const language = field("Please type in a language that you speak", { id: "language", kind: "text", required: false });
  const level = field("Select your level", { id: "level", kind: "combobox", options: ["Beginner", "Intermediate", "Advanced", "Fluent"], required: false });
  const answered = proposals([language, level], speaker);
  assert.equal(answered.find((p) => p.fieldId === language.id)?.value, "English");
  const said = answered.find((p) => p.fieldId === level.id);
  assert.ok(said && [said.value, ...(said.choices || [])].includes("Fluent"), JSON.stringify(said));
  // No languages in the profile: left alone.
  assert.equal(proposals([language], profileSchema.parse({ ...profile, languages: [] }))[0]?.value, undefined);
});

// Riot Games' Greenhouse form: three required
// react-select lists, their options unread until opened, were left empty.
test("Riot Games' Greenhouse lists: Other as None of the above, a business-fluent language, and N/A after a No", () => {
  const speaker = profileSchema.parse({ ...profile, referralSource: [], languages: ["English: Native", "Spanish: Basic"] });
  const hear = field("How did you hear about this job?", { id: "hear", kind: "combobox" });
  const heard = proposals([hear], speaker)[0];
  assert.equal(pickListOption(heard, ["Company Website", "Linkedin", "Employee Referral", "Social Media", "None of the above / Other"], (option) => option), "None of the above / Other");
  // Adatum's list names its Other "Source not in list": the applicant picked it by hand.
  assert.equal(pickListOption(heard, ["Company Website", "Linkedin", "Employee Referral", "Source not in list"], (option) => option), "Source not in list");
  // A list with no plain Other, only "Other Job Board" (and "Event Other", an event): the job board.
  assert.equal(pickListOption(heard, ["Acme Careers", "I was referred by an Employee", "Event Other", "Glassdoor", "LinkedIn", "Other Job Board", "Zip Recruiter"], (option) => option), "Other Job Board");
  // A multi-select of languages: the fluent one, never the basic one.
  const fluent = field("In which language(s) are you business fluent?", { id: "fluent", kind: "combobox" });
  const languages = proposals([fluent], speaker)[0];
  assert.equal(languages?.value, "English");
  assert.deepEqual(languages?.choices || [], []);
  assert.equal(proposals([{ ...fluent, options: ["French", "English", "Other"] }], speaker)[0]?.value, "English");
  // "If yes, …" after a No: the list's n/a, never a month.
  const parent = field("As we are majority owned by Contoso, we would like to know if you have worked for Contoso or an affiliated company within the last 12 months.", { id: "parent", kind: "combobox", value: "No" });
  const month = field("If yes, can you please indicate the last month you worked for Contoso and/or an affiliate company.", { id: "month", kind: "combobox" });
  const months = ["n/a", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const unread = proposals([parent, month], speaker).find((p) => p.fieldId === "month");
  assert.ok(unread);
  assert.equal(pickListOption(unread, months, (option) => option), "n/a");
  assert.equal(proposals([parent, { ...month, options: months }], speaker).find((p) => p.fieldId === "month")?.value, "n/a");
  // After a Yes, or with no N/A in the list, the month is the applicant's.
  assert.equal(proposals([{ ...parent, value: "Yes" }, month], speaker).find((p) => p.fieldId === "month"), undefined);
  assert.equal(proposals([parent, { ...month, options: months.slice(1) }], speaker).find((p) => p.fieldId === "month"), undefined);
  assert.equal(proposals([{ ...parent, value: "" }, month], speaker).find((p) => p.fieldId === "month"), undefined);
  // Oracle's box after sponsorship answered No, saying itself to type N/A.
  const sponsor = field("Will you now or in the future require Contoso to provide any form of sponsorship to work or continue to work for Contoso in the U.S.? (e.g. H-1B, TN, L1, OPT, etc.).", { id: "sponsor", kind: "radio", options: ["Yes", "No"], value: "No" });
  const kind = field("If your response above is “Yes”, what type of sponsorship do you require? If no, please type N/A.", { id: "kind", kind: "textarea", required: true });
  assert.equal(proposals([sponsor, kind], speaker).find((p) => p.fieldId === "kind")?.value, "N/A");
  // After a Yes, or unanswered, the type is the applicant's.
  assert.notEqual(proposals([{ ...sponsor, value: "Yes" }, kind], speaker).find((p) => p.fieldId === "kind")?.value, "N/A");
  assert.notEqual(proposals([{ ...sponsor, value: "" }, kind], speaker).find((p) => p.fieldId === "kind")?.value, "N/A");
});

// Enovation's Paylocity rows: with "When can you
// start? Immediately" saved, each Work History row's Start Date was given this
// month, over the job's own start, and over dates the applicant set by hand.
test("a job's Start Date is its own, though an availability answer is saved", () => {
  const ready = profileSchema.parse({
    ...profile,
    answers: [{ question: "When can you start?", answer: "Immediately" }],
    work: [{ organization: "Contoso", title: "Engineer", startDate: "2025-03-01", endDate: "", location: "", details: "" }],
  });
  const row = field("Start Date", { id: "row", kind: "text", section: "Work History", index: 0, format: "MM/YYYY", required: false });
  assert.equal(proposals([row], ready)[0]?.value, "03/2025");
  // Asked outside any row, it is still when the applicant could start.
  const available = field("Start Date", { id: "available", kind: "text", format: "MM/YYYY", required: false });
  assert.match(String(proposals([available], ready)[0]?.value), /^\d{2}\/\d{4}$/);
});

// Litware's iCIMS screening step: work authorization asked the
// other way round.
test("legal restrictions to working are the inverse of work authorization", () => {
  const citizen = profileSchema.parse({ ...profile, workAuthorization: [{ country: "US", status: "citizen", needsSponsorship: false }], applyingTo: { country: "US" } });
  const asked = field("Do you have any legal restrictions to working in the country where this position is located?", { id: "restrict", kind: "select", options: ["Yes", "No"] });
  assert.equal(proposals([asked], citizen)[0]?.value, "No");
});

test("'legally eligible for employment in this country' is work authorization, answered from the profile", () => {
  const citizen = profileSchema.parse({ ...profile, workAuthorization: [{ country: "US", status: "citizen", needsSponsorship: false }], applyingTo: { country: "US" } });
  const asked = field("Are you legally eligible for employment in this country? Proof of eligibility will be required upon employment .", { id: "eligible", kind: "radio", options: ["Yes", "No"] });
  assert.equal(proposals([asked], citizen)[0]?.value, "Yes");
});

// Woodgrove's Workday export-control question.
test("a Yes/No question about citizenship of a sanctioned country is No for a citizen elsewhere", () => {
  const elsewhere = profileSchema.parse({ ...profile, country: "United States", citizenships: ["US"] });
  const asked = field("Are you a citizen, national or permanent resident of Iran, Cuba, North Korea or Syria?", { id: "embargo", kind: "combobox", options: [] });
  assert.equal(proposals([asked], elsewhere)[0]?.value, "No");
  // As the live page has it, after a paragraph with no space before it.
  const joined = field("As a U.S. company that exports software and technology internationally, we must comply with U.S. export control laws. The information provided will be used to determine whether we need an Export Control License for your employment if you are hired.Are you a citizen, national or permanent resident of Iran, Cuba, North Korea or Syria?", { id: "joined", kind: "combobox", options: [] });
  assert.equal(proposals([joined], elsewhere)[0]?.value, "No");
  // Without citizenships in the profile, left alone.
  assert.equal(proposals([asked], profileSchema.parse({ ...profile, citizenships: [] }))[0]?.value, undefined);
});

// Woodgrove's Workday: a model answered "What is your preferred
// geographic location?" with a work arrangement.
test("a preferred geographic location box says where, from the willingness to relocate", () => {
  const anywhere = profileSchema.parse({ ...profile, willingToRelocate: "Yes", city: "Blacksburg", state: "VA" });
  const asked = field("What is your preferred geographic location?", { id: "where", kind: "textarea", required: false });
  assert.equal(proposals([asked], anywhere)[0]?.value, "Open to any location; currently in Blacksburg, VA");
  assert.equal(proposals([asked], profileSchema.parse({ ...profile, willingToRelocate: "" }))[0]?.value, undefined);
});

// Woodgrove's Workday: the panel said "Normal fill could not
// match this field" for questions the fill leaves on purpose.
test("a question left on purpose says why", async () => {
  const { leftReason } = await import("../src/shared/questions");
  assert.match(leftReason("I acknowledge that I have read, reviewed and answered the above questions truthfully and accurately.") || "", /attestation/);
  assert.match(leftReason("Are you currently or have you in the past been debarred, suspended, proposed for debarment by any federal agency?") || "", /legal question/);
  assert.match(leftReason("Regarding future positions at Contoso, please select one of the following options") || "", /preference/);
  assert.equal(leftReason("Phone number"), undefined);
});

// Woodgrove's Workday questionnaire: a date in
// three boxes named "<question> date: Month", ": Day" and ": Year".
test("a graduation date asked in Month, Day and Year boxes after a colon gets each part", () => {
  const graduating = profileSchema.parse({ ...profile, education: [{ organization: "Penn State", title: "Master of Science", startDate: "2025-08", endDate: "2099-05-10", location: "", details: "" }] });
  const part = (name: string) => proposals([field(`Please input your anticipated graduation date: ${name}`, { id: name, kind: "text", required: true })], graduating)[0];
  assert.equal(part("Month")?.value, "May");
  assert.ok(["05", "5"].some((form) => [part("Month")?.value, ...(part("Month")?.choices || [])].includes(form)));
  assert.equal(part("Day")?.value, "10");
  assert.equal(part("Year")?.value, "2099");
});

// Oracle's Higher: the site kept "22 Mustang Dr" and "Apt 22".
test("an Apt/Flat# box is emptied only beside a street the site kept that is not the profile's, and Oracle's address search is given its whole-address wordings", () => {
  const home = profileSchema.parse({ ...profile, address: "100 E. Main St", addressLine2: "", city: "Blacksburg", state: "VA", postalCode: "24060", country: "United States" });
  const street = (value: string, overrides: Partial<Field> = {}) => field("Address Line 1", { id: "a1", kind: "combobox", value, siteValue: true, ...overrides });
  const apt = (overrides: Partial<Field> = {}) => field("Apt/Flat#", { id: "a2", required: false, value: "Apt 22", siteValue: true, ...overrides });
  const both = proposals([street("22 Mustang Dr"), apt()], home);
  assert.equal(both.find((p) => p.fieldId === "a2")?.value, "");
  const one = both.find((p) => p.fieldId === "a1");
  assert.equal(one?.value, "100 E. Main St");
  assert.ok(one?.choices?.includes("100 E. Main St, Blacksburg, VA"));
  assert.ok(one?.choices?.some((choice) => /Virginia, 24060$/.test(choice)));
  // The profile's own street kept, no street on the page, or the applicant's own unit: left alone.
  assert.deepEqual(proposals([street("100 E. Main St"), apt()], home).filter((p) => p.fieldId === "a2"), []);
  assert.deepEqual(proposals([apt()], home), []);
  assert.deepEqual(proposals([street("22 Mustang Dr"), apt({ siteValue: false })], home).filter((p) => p.fieldId === "a2"), []);
});

// Wingtip's iCIMS form: "Date Available to
// Start" (Month, Day, Year), "Desired Salary" (Amount, numbers only) and the
// school's own "School City" and "School State" were left empty.
test("an iCIMS start date's parts, a numbers-only desired salary and a school's place are answered", () => {
  const applicant = profileSchema.parse({
    ...profile,
    salary: { min: 95000, currency: "$", period: "year" },
    education: [
      { organization: "Virginia Tech", title: "Bachelor of Science", location: "Blacksburg, VA", startDate: "2020-09", endDate: "2024-06", details: "" },
    ],
    answers: [{ question: "When can you start?", answer: "Immediately" }],
  });
  const today = new Date();
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const ask = (label: string, overrides: Partial<Field> = {}) => proposals([field(label, overrides)], applicant)[0];
  assert.equal(ask("Date Available to Start: Month", { kind: "select", options: months.map((name) => name.slice(0, 3)) })?.value, months[today.getMonth()].slice(0, 3));
  assert.equal(ask("Date Available to Start: Day", { kind: "select", options: Array.from({ length: 31 }, (_, i) => String(i + 1)) })?.value, String(today.getDate()));
  assert.equal(ask("Date Available to Start: Year", { kind: "text" })?.value, String(today.getFullYear()));
  assert.equal(ask("Desired Salary: Amount (Numbers only)", { kind: "text" })?.value, "95000");
  assert.equal(ask("School City", { kind: "text" })?.value, "Blacksburg");
  assert.equal(ask("School State", { kind: "text" })?.value, "Virginia");
  // No place saved for the school: nothing is said, never the home address.
  const none = profileSchema.parse({ ...applicant, education: [{ ...applicant.education[0], location: "" }] });
  assert.equal(proposals([field("School City", { kind: "text" })], none)[0], undefined);
});

// iCIMS' "Education (Completed)" part: it says
// to enter only the highest level graduated from. The degree still under way
// went into its first block and the finished one into its second.
test("a completed-education section takes only the highest finished degree, in its first block", () => {
  const who = profileSchema.parse({
    ...profile,
    education: [
      { organization: "Virginia Tech", title: "Master's Degree", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2027-12", current: true, location: "Blacksburg, VA" },
      { organization: "Penn State", title: "Bachelor's Degree", fieldOfStudy: "Computer Science", startDate: "2016-08", endDate: "2020-05", location: "University Park, PA" },
    ],
  });
  const block = (index: number) => [
    field("School/Institution Name", { id: `name${index}`, section: "EDUCATION (COMPLETED)", index }),
    field("City", { id: `city${index}`, section: "EDUCATION (COMPLETED)", index }),
    field("State/Province", { id: `state${index}`, section: "EDUCATION (COMPLETED)", index }),
    field("Did you Graduate?", { id: `grad${index}`, section: "EDUCATION (COMPLETED)", index, kind: "select", options: ["Yes", "No"] }),
    field("Type of Degree (High School/GED/Bachelor/etc.)", { id: `degree${index}`, section: "EDUCATION (COMPLETED)", index }),
    field("Major/Area of Study", { id: `major${index}`, section: "EDUCATION (COMPLETED)", index }),
  ];
  const answers = Object.fromEntries(proposals([...block(0), ...block(1)], who).map((p) => [p.fieldId, p.value]));
  assert.equal(answers.name0, "Penn State");
  assert.equal(answers.city0, "University Park");
  assert.equal(answers.state0, "Pennsylvania");
  assert.equal(answers.grad0, "Yes");
  assert.equal(answers.degree0, "Bachelor's Degree");
  assert.equal(answers.major0, "Computer Science");
  for (const id of ["name1", "city1", "state1", "grad1", "degree1", "major1"]) assert.equal(answers[id], undefined, id);
  // Only a degree still under way: nothing is entered as completed.
  assert.deepEqual(proposals(block(0), { ...who, education: [who.education[0]] }), []);
  // The "currently enrolled" part is asked outside it, and takes the degree under way.
  const current = proposals([field("Current School/Institution Name", { id: "now", kind: "select", options: ["Penn State", "Virginia Tech"] })], who);
  assert.equal(current[0]?.value, "Virginia Tech");
});

// SmartRecruiters' screening step: its Yes/No
// questions and its graduation year list went unanswered.
test("a fixed start date, the advertised salary band and the graduation year asked on a screening step are answered from the profile", () => {
  const yesNo = (label: string, p = profile) => proposals([field(label, { kind: "radio", options: ["Yes", "No"] })], p)[0]?.value;
  const starting = (answer: string) => profileSchema.parse({ ...profile, answers: [{ question: "When can you start?", answer }] });
  const fixed = "This program has a fixed start date mentioned in the job advert. Are you available to join on that date?";
  assert.equal(yesNo(fixed, starting("Immediately")), "Yes");
  // Another saved start may not be in time; none says nothing.
  assert.equal(yesNo(fixed, starting("Two weeks' notice")), undefined);
  assert.equal(yesNo(fixed), undefined);
  assert.equal(yesNo("Does the advertised salary band meet your expectations?"), "Yes");
  // A figure named is weighed against the profile's, not taken on trust.
  assert.notEqual(yesNo("Does a salary band of $40,000 to $50,000 meet your expectations?", profileSchema.parse({ ...profile, salary: { min: 100000, currency: "USD", period: "year" } })), "Yes");
  // Being a customer, or having audited the company, the profile cannot say.
  assert.equal(yesNo("Are you currently a Acme customer?"), undefined);
  assert.equal(yesNo("Were you involved, in any capacity, in the audit of Acme’s financial statements, including those who provided concurring or second partner reviews, or consulted on technical or industry specific issues, in the last 12 months?"), undefined);
  assert.equal(proposals([field("Which year did/do you Graduate?", { kind: "combobox", options: ["2026", "2027", "2028", "Other"] })], profile)[0]?.value, "2028");
});

test("a sponsorship question followed by a list of visa types that includes STEM OPT is answered from the profile (iCIMS, 2026-11-12)", () => {
  const citizen = Object.assign(profileSchema.parse({ ...profile, workAuthorization: [{ country: "US", status: "citizen", needsSponsorship: false }] }), { applyingTo: { country: "US", company: "Acme", title: "Intern" } });
  const label = "Will you in the future need visa sponsorship? This will typically apply for individuals of any of the following visa statuses: F1/OPT, F-1/STEM OPT, F1/CPT, H-1B, H-1B1, E-1/E-2, E-3, L-1A/L-1B, TN, O-1, AOS-based EAD?";
  assert.equal(proposals([field(label, { kind: "select", options: ["Yes", "No"], required: true })], citizen)[0]?.value, "No");
});

test("questions about the company applied to and its family are No for an applicant who never worked for one (iCIMS, 2026-11-12)", () => {
  const base = { ...profile, currentCompany: "Contoso", neverWorkedForApplyingCompanies: true };
  const never = Object.assign(profileSchema.parse(base), { applyingTo: { country: "US", company: "Acme Motors, LLC", title: "Intern" } });
  const ask = (label: string, options: string[], who = never) => proposals([field(label, { kind: "select", options, required: true })], who)[0]?.value;
  const statuses = ["Never Employed by Acme or One of its Subsidiaries", "Former Employee (Acme Motors, LLC)", "Current Employee"];
  assert.equal(ask("Which best describes your current status with Acme Motors, LLC (formerly Northwind) or one of its related companies?", statuses), statuses[0]);
  assert.equal(ask("Are you currently or have you been an Acme Defense LLC (former Northwind Defense) employee or contractor within the last 12 months?", ["Yes", "No"]), "No");
  assert.equal(ask("Do you currently work for an Acme Truck Vehicle Sales Dealership?", ["Yes", "No"]), "No");
  // Oracle's wording: "Are you currently working for …".
  assert.equal(ask("Are you currently working for Acme Manufacturing outside of the United States?", ["Yes", "No"]), "No");
  assert.equal(ask("Are you currently working for a Acme Manufacturing Distributor or Pro Partner?", ["Yes", "No"]), "No");
  // Left alone: a company the question does not name, an employer who is the company's, and no saying never.
  assert.equal(ask("Do you currently work for a Fabrikam Dealership?", ["Yes", "No"]), undefined);
  assert.equal(ask("Do you currently work for an Acme Truck Vehicle Sales Dealership?", ["Yes", "No"], Object.assign(profileSchema.parse({ ...base, currentCompany: "Acme Dealer Group" }), { applyingTo: never.applyingTo })), undefined);
  const unsaid = Object.assign(profileSchema.parse({ ...base, neverWorkedForApplyingCompanies: undefined, work: [] }), { applyingTo: never.applyingTo });
  assert.equal(ask("Which best describes your current status with Acme Motors, LLC or one of its related companies?", statuses, unsaid), undefined);
});

test("a referral by a current employee that names no company is No when no reference or job of the applicant's is at the company applied to", () => {
  const who = Object.assign(profileSchema.parse({ ...profile, references: [{ name: "Jordan Lee", relationship: "Director of Northwind Labs", phone: "", email: "jordan@example.com" }] }), { applyingTo: { country: "US", company: "Acme Motors, LLC", title: "Intern" } });
  const ask = (target: typeof who) => proposals([field("Were you referred to this position by a current Employee?", { kind: "select", options: ["Yes", "No"], required: true })], target)[0]?.value;
  assert.equal(ask(who), "No");
  const vouched = Object.assign(profileSchema.parse({ ...who, references: [{ name: "Jordan Lee", relationship: "Director at Acme", phone: "", email: "" }] }), { applyingTo: who.applyingTo });
  assert.equal(ask(vouched), undefined);
});

// Pinpoint's form: the graduation date is three selects named "<question> -
// Day", "- Month", "- Year"; the profile holds only the month, and the site
// rejects a date without its day. Its zip box is "Zipcode", and "how soon"
// asks the start date.
test("a graduation date's Day list beside Month and Year takes the 1st, and a Zipcode and a how-soon start are answered", () => {
  const monthOnly = profileSchema.parse({ ...profile, education: [{ ...profile.education[0], endDate: "2099-05" }], answers: [{ question: "When can you start?", answer: "Immediately" }] });
  const question = "Please indicate your most recent or expected graduation year/date (for your bachelor's, master's, or PhD).";
  const days = Array.from({ length: 31 }, (_, i) => String(i + 1));
  const part = (name: string, options: string[]) => proposals([field(`${question} - ${name}`, { kind: "select", options })], monthOnly)[0]?.value;
  assert.equal(part("Day", days), "1");
  assert.equal(part("Month", ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]), "May");
  assert.equal(part("Year", ["2099", "2098"]), "2099");
  // A day the profile holds is used.
  const held = profileSchema.parse({ ...monthOnly, education: [{ ...profile.education[0], endDate: "2099-05-17" }] });
  assert.equal(proposals([field(`${question} - Day`, { kind: "select", options: days })], held)[0]?.value, "17");
  assert.equal(deterministicAnswer(field("Zipcode"), monthOnly), monthOnly.postalCode);
  assert.equal(proposals([field("If offered the position, how soon would you be able to start?", { kind: "combobox", required: false })], monthOnly)[0]?.value, "Immediately");
});

// An iCIMS street search writes its listing's own wording ("100 East Mill
// Way") into the box; read as a different street, it was searched and picked
// again every pass.
test("a street the site holds in its listing's words is the saved street, not searched again", () => {
  const saved = profileSchema.parse({ ...profile, address: "100 E. Mill Way", city: "Blacksburg", state: "Virginia" });
  assert.deepEqual(proposals([field("Address", { kind: "combobox", value: "100 East Mill Way", siteValue: true })], saved), []);
  // Another street is still corrected.
  assert.equal(proposals([field("Address", { kind: "combobox", value: "200 East Mill Way", siteValue: true })], saved)[0]?.value, "100 E. Mill Way");
});

// An Ashby form asked "What city do you live in?" and "Have you been employed
// by Acme before?"; the profile holds both answers (report fab8c1fc).
test("What city do you live in takes the saved city, and employed by the company before is answered", () => {
  const applicant = Object.assign(profileSchema.parse({ ...profile, city: "Blacksburg", state: "Virginia", country: "United States", neverWorkedForApplyingCompanies: true }), { applyingTo: { company: "Acme", title: "Intern", country: "US" } });
  const city = proposals([field("What city do you live in?", { kind: "combobox", options: [] })], applicant)[0]?.value;
  assert.ok(city && city.startsWith("Blacksburg"), String(city));
  assert.equal(proposals([field("Have you been employed by Acme before?", { kind: "radio", options: ["Yes", "No"] })], applicant)[0]?.value, "No");
});

// An audit found the model filling these profile questions because no rule
// answered them (Workday, Tesla, Taleo, Ashby and other forms).
const rivera = profileSchema.parse({
  ...profile,
  firstName: "Alex",
  middleName: "Quinn",
  lastName: "Rivera",
  preferredName: "Lex",
  email: "alex@example.test",
  phone: "5405550100",
  address: "100 Mill Way",
  city: "Blacksburg",
  state: "Virginia",
  postalCode: "24060",
  linkedin: "linkedin.com/in/alex-rivera",
  salary: { min: 100000, currency: "$", period: "year" },
  education: [{ organization: "Penn State", title: "Bachelor of Science", fieldOfStudy: "Information Technology", startDate: "2020-08", endDate: "2024-05" }],
  answers: [{ question: "When can you start?", answer: "Immediately" }],
});
const valueOf = (label: string, overrides: Partial<Field> = {}, who = rivera) => proposals([field(label, overrides)], who)[0]?.value;
const yesNo = { kind: "radio" as const, options: ["Yes", "No"] };

test("a preferred-name box, middle name and optional preferred name are answered from the name fields", () => {
  assert.equal(valueOf("I have a preferred name", yesNo), "Yes");
  assert.equal(valueOf("I have a preferred name", yesNo, profileSchema.parse({ ...rivera, preferredName: "Alex" })), "No");
  assert.equal(valueOf("Middle Name (Optional)", { required: false }), "Quinn");
  assert.equal(valueOf("Preferred Name (Optional)", { required: false }), "Lex");
});

test("a LinkedIn yes/no and a URL-only request are answered from the saved address", () => {
  assert.equal(valueOf("Do you have a LinkedIn profile?", yesNo), "Yes");
  assert.equal(valueOf("Do you have a LinkedIn profile?", yesNo, profileSchema.parse({ ...rivera, linkedin: "" })), undefined);
  assert.equal(valueOf("Please enter only the URL to your LinkedIn profile. Do not include any additional text."), "https://linkedin.com/in/alex-rivera");
});

test("personal email, phone, home zip and physical address asked as sentences are answered from the profile", () => {
  assert.equal(valueOf("What is your personal email address?"), "alex@example.test");
  assert.equal(valueOf("What is your phone number?"), "5405550100");
  assert.equal(valueOf("* Daytime Phone"), "5405550100");
  assert.equal(valueOf("What is your home Zip Code?"), "24060");
  assert.equal(valueOf("Physical Address"), "100 Mill Way, Blacksburg, Virginia 24060");
  assert.equal(valueOf("Physical Address", { kind: "combobox" }), undefined);
});

test("a salary asked as 'salary or hourly wage' or 'required' gets the saved yearly figure", () => {
  assert.equal(valueOf("* What is your desired salary or hourly wage?"), "$100,000");
  assert.equal(valueOf("Wage Or Salary Required"), "$100,000");
  // An hourly-only question is still not answered with a yearly figure.
  assert.equal(valueOf("Desired hourly wage"), undefined);
});

test("a bachelor's degree in a listed field, and a bachelor's or master's held or under way, are answered Yes", () => {
  const listed = "* Do you have a bachelor’s degree in information technology, management information systems, computer science, or a related field of study? Yes No";
  assert.equal(valueOf(listed, yesNo), "Yes");
  const other = profileSchema.parse({ ...rivera, education: [{ ...rivera.education[0], fieldOfStudy: "Music" }] });
  assert.equal(valueOf(listed, yesNo, other), undefined);
  const either = "Currently has, or is in the process of obtaining, a bachelor's or Master's degree";
  assert.equal(valueOf(either, yesNo), "Yes");
  const none = profileSchema.parse({ ...rivera, education: [] });
  assert.equal(valueOf(either, yesNo, none), undefined);
});

test("a bachelor's under way in listed fields is answered Yes from a current row, No when only another degree is under way, and left otherwise", () => {
  const asked = "Are you pursuing a Bachelor's Degree in Computer Science, Engineering, or equivalent?";
  const row = { ...rivera.education[0], title: "Bachelor of Science", fieldOfStudy: "Computer Science", startDate: "2024-08-15", endDate: "2099-05-15", current: true };
  const studying = profileSchema.parse({ ...rivera, education: [row] });
  assert.equal(valueOf(asked, yesNo, studying), "Yes");
  // A finished bachelor's and a master's under way: not pursuing one.
  const graduate = profileSchema.parse({ ...rivera, education: [
    { ...row, title: "Master of Science", fieldOfStudy: "Data Science" },
    { ...row, startDate: "2016-08-15", endDate: "2020-05-15", current: false },
  ] });
  assert.equal(valueOf(asked, yesNo, graduate), "No");
  // A bachelor's under way in another field may be "equivalent": left.
  const other = profileSchema.parse({ ...rivera, education: [{ ...row, fieldOfStudy: "History" }] });
  assert.equal(valueOf(asked, yesNo, other), undefined);
  // Nothing under way: not known from the rows, left.
  const done = profileSchema.parse({ ...rivera, education: [{ ...row, endDate: "2020-05-15", current: false }] });
  assert.equal(valueOf(asked, yesNo, done), undefined);
  assert.equal(profileFactQuestion({ label: asked, kind: "radio", options: ["Yes", "No"] } as never), true);
});

test("an availability or notice period question takes a saved Immediately", () => {
  assert.equal(valueOf("What is your availability or notice period?"), "Immediately");
  const weeks = profileSchema.parse({ ...rivera, answers: [{ question: "When can you start?", answer: "Two weeks' notice" }] });
  assert.equal(valueOf("What is your availability or notice period?", {}, weeks), undefined);
});

// A Lever questionnaire: a multiple-select question draws one box per option,
// each observed as "<question>: <option>". The acknowledgement rule
// ticked every box (report 55bf383a); only the box naming it is ticked.
test("an acknowledgement question drawn as one box per option ticks only the box naming it", () => {
  const question = "I confirm that I have read the full job description for this position.";
  const applicant = profileSchema.parse({ ...profile, acknowledgeTerms: true });
  const ticks = (options: string[]) =>
    options.map((option) => proposals([field(`${question}: ${option}`, { kind: "checkbox", question })], applicant)[0]?.value);
  assert.deepEqual(ticks(["Yes", "No"]), ["Yes", undefined]);
  assert.deepEqual(ticks(["Yes, I confirm the above", "No, I have remaining coursework that will make it difficult"]), ["Yes", undefined]);
});

test("a gender identity combobox listing Man and Woman takes Male and Female from the profile (report f9a26be6)", () => {
  const options = ["Man", "Non-binary", "Woman", "I prefer to self-describe", "I don't wish to answer"];
  const pick = (gender: string) =>
    valueOf("How would you describe your gender identity?", { kind: "combobox", options }, profileSchema.parse({ ...rivera, gender }));
  assert.equal(pick("Male"), "Man");
  assert.equal(pick("Female"), "Woman");
  // A react-select that lists its options only once opened: the answer carries
  // the wordings to look for, and each is a whole option.
  const closed = (gender: string) =>
    proposals([field("How would you describe your gender identity?", { kind: "combobox", options: [] })], profileSchema.parse({ ...rivera, gender }))[0]?.choices;
  assert.deepEqual(closed("Male"), ["Man", "Man/Male", "Male/Man"]);
  assert.deepEqual(closed("Female"), ["Woman", "Woman/Female", "Female/Woman"]);
});

// Ashby lists graduation as combined seasons and the degree program under
// way as a radio group; Greenhouse asks the state of residence in a
// searchable list with no options captured.
const riveraProfile = (education: Array<Record<string, unknown>>) =>
  profileSchema.parse({ ...profile, firstName: "Alex", lastName: "Rivera", state: "Ohio", postalCode: "24060", education });

test("an expected graduation date as combined seasons picks the option holding the end date", () => {
  const options = ["Spring/Summer 2099", "Fall/Winter 2099", "Spring/Summer 2100", "Winter 2101 or later"];
  const pick = (end: string, list = options) =>
    proposals([field("When is your expected graduation date (month and year)?", { kind: "radio", options: list })], riveraProfile([{ organization: "Penn State", title: "Masters of Science", startDate: "2025-08-21", endDate: end }]))[0]?.value;
  assert.equal(pick("2099-12-13"), "Fall/Winter 2099");
  assert.equal(pick("2099-05-10"), "Spring/Summer 2099");
  assert.equal(pick("2102-03-01"), "Winter 2101 or later");
  assert.equal(pick("2098-05-10"), undefined);
  // A text box keeps the month and year.
  assert.equal(proposals([field("When is your expected graduation date (month and year)?")], riveraProfile([{ organization: "Penn State", title: "Masters of Science", startDate: "2025-08", endDate: "2099-12-13" }]))[0]?.value, "December 2099");
});

test("the degree program a student is enrolled in names the level of the program under way", () => {
  const options = ["Undergraduate (B.S./B.A)", "Master's (M.S./M.A.)", "Ph.D.", "Non-Degree/Bootcamp/Certificate", "Not Currently Enrolled"];
  const pick = (education: Array<Record<string, unknown>>) =>
    proposals([field("What degree program are you actively enrolled in?", { kind: "radio", options })], riveraProfile(education))[0]?.value;
  const past = { organization: "Virginia Tech", title: "Bachelors of Science", startDate: "2020-09", endDate: "2024-06-15" };
  assert.equal(pick([{ organization: "Penn State", title: "Masters of Science", startDate: "2025-08", endDate: "2099-12-13", current: true }, past]), "Master's (M.S./M.A.)");
  assert.equal(pick([{ organization: "Penn State", title: "Doctor of Philosophy", startDate: "2025-08", endDate: "2099-12-13", current: true }, past]), "Ph.D.");
  assert.equal(pick([{ organization: "Virginia Tech", title: "Bachelors of Science", startDate: "2025-08", endDate: "2099-05", current: true }]), "Undergraduate (B.S./B.A)");
  assert.equal(pick([past]), "Not Currently Enrolled");
});

test("an Oracle authorization question listing the statuses that count, temporary residents among them, is Yes for a citizen and unanswered without a US entry", () => {
  const label = "Are you currently lawfully authorized to work in the U.S. for any employer, as a (i) U.S. citizen or national; (ii) permanent resident; (iii) lawful temporary resident; (iv) foreign national admitted as a refugee; or (v) foreign national for whom asylum has been granted?";
  const answer = (who: typeof profile) => proposals([field(label, yesNo)], who)[0]?.value;
  const citizen = profileSchema.parse({ ...riveraProfile([]), workAuthorization: [{ country: "US", status: "citizen", needsSponsorship: false }], citizenships: ["US"] });
  assert.equal(answer(citizen), "Yes");
  assert.equal(answer(profileSchema.parse({ ...citizen, workAuthorization: [{ country: "CA", status: "citizen", needsSponsorship: false }], citizenships: ["CA"] })), undefined);
  assert.equal(answer(profileSchema.parse({ ...citizen, workAuthorization: [], citizenships: [] })), undefined);
  // A question that asks about a temporary permit is still left alone.
  assert.equal(proposals([field("Please provide your temporary work authorization documents", yesNo)], citizen)[0]?.value, undefined);
});

test("an Oracle degree question, pursued or completed, is the highest degree, and the discipline being studied is the current program's field", () => {
  const options = ["High School Diploma/GED", "Technical Diploma", "Associate's Degree/College Diploma", "Non-Degree Program", "Bachelor's Degree", "Master's Degree", "Doctorate Degree", "Higher Degree"];
  const who = riveraProfile([
    { organization: "Penn State", title: "Masters of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2099-12", current: true },
    { organization: "Virginia Tech", title: "Bachelors of Science", fieldOfStudy: "Information Technology", startDate: "2020-08", endDate: "2024-05" },
  ]);
  assert.equal(proposals([field("Degree you are currently pursuing or have completed", { kind: "radio", options })], who)[0]?.value, "Master's Degree");
  const discipline = "I am working towards a degree in the following discipline: Choose all that apply";
  assert.equal(proposals([field(discipline, { kind: "combobox", required: true })], who)[0]?.value, "Data Science");
  assert.equal(proposals([field(discipline, { kind: "combobox", required: true, options: ["Biology", "Data Science", "History"] })], who)[0]?.value, "Data Science");
});

test("an Oracle graduation month is the month name before its list is read, a data program is never put down as a neighbouring discipline, and a phone prefix list reads '+1 (United States)'", () => {
  const who = riveraProfile([{ organization: "Penn State", title: "Masters of Science", fieldOfStudy: "Data Science", startDate: "2025-08", endDate: "2099-12", current: true }]);
  const monthLabel = "What is your anticipated graduation month?";
  // An unopened cx-select: no options read, and the month alone is asked.
  assert.equal(proposals([field(monthLabel, { kind: "combobox", required: true })], who)[0]?.value, "December");
  assert.equal(proposals([field(monthLabel, { kind: "combobox", options: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] })], who)[0]?.value, "December");
  assert.equal(proposals([field("What is your anticipated graduation year?", { kind: "combobox", required: true })], who)[0]?.value, "2099");
  const discipline = "I am working towards a degree in the following discipline: Choose all that apply";
  const found = proposals([field(discipline, { kind: "combobox", required: true })], who)[0];
  assert.equal(found?.value, "Data Science");
  // Never a neighbouring discipline the applicant does not study.
  assert.ok(!found?.choices?.includes("Computer Science"));
  const code = proposals([field("Country code", { kind: "combobox" })], profileSchema.parse({ ...who, phone: "+1 614 555 0100", country: "United States" }))[0];
  assert.ok(code?.choices?.includes("+1 (United States)"), JSON.stringify(code));
});

test("an Oracle previous internship, co-op or relevant work experience question is yes when the profile has work entries", () => {
  const label = "Do you have previous internship, co-op, and/or directly relevant work experience?";
  const options = ["No", "Yes- other company"];
  const work = [{ organization: "Acme", title: "Intern", startDate: "2023-06", endDate: "2023-08" }];
  const answered = proposals([field(label, { kind: "radio", options })], profileSchema.parse({ ...profile, work }))[0];
  assert.equal(answered?.value, "Yes- other company");
  assert.deepEqual(proposals([field(label, { kind: "radio", options })], profileSchema.parse({ ...profile, work: [] })), []);
});

test("the state a person resides in is the profile's state, not other state questions", () => {
  const person = riveraProfile([]);
  const ask = (label: string) => proposals([field(label, { kind: "combobox", options: [] })], person)[0]?.value;
  assert.equal(ask("Please list the state that you permanently reside in"), "Ohio");
  assert.equal(ask("What state do you live in?"), "Ohio");
  assert.equal(ask("Which state do you currently reside in?"), "Ohio");
  assert.notEqual(ask("Please state your reason"), "Ohio");
  assert.notEqual(ask("Do you reside in the United States?"), "Ohio");
});

// BambooHR asks "Are you willing and able to commute to this job's on-site
// location??" (a doubled mark) as Yes or No. The profile answers it only where
// it says so: living in the job's city, or willing to relocate.
test("a commute question to the job's on-site location is answered from the job's city or a willingness to relocate, and left otherwise", () => {
  const asked = (who: Record<string, unknown>, location?: string, label = "Are you willing and able to commute to this job's on-site location?") =>
    proposals([field(label, { kind: "radio", options: ["Yes", "No"] })], { ...profileSchema.parse({ ...profile, city: "Columbus", state: "Ohio", ...who }), ...(location ? { applyingTo: { location } } : {}) })[0]?.value;
  // Where the applicant lives, from the posting's place.
  assert.equal(asked({}, "Columbus, OH, United States"), "Yes");
  assert.equal(asked({}, "Columbus, Ohio"), "Yes");
  assert.equal(asked({}), undefined);
  assert.equal(asked({}, "Cleveland, OH, United States"), undefined);
  // The same city name in another state is another place.
  assert.equal(asked({}, "Columbus, GA, United States"), undefined);
  // Willing to relocate is willing to be there; unwilling says nothing of commuting.
  assert.equal(asked({ willingToRelocate: "Yes" }), "Yes");
  assert.equal(asked({ willingToRelocate: "No" }, "Cleveland, OH"), undefined);
  // A saved answer to the same question counts.
  assert.equal(asked({ answers: [{ question: "Are you able to commute to the office?", answer: "Yes" }] }), "Yes");
  // The doubled question mark does not stop the match.
  assert.equal(asked({ willingToRelocate: "Yes" }, undefined, "Are you willing and able to commute to this job's on-site location??"), "Yes");
});

test("a saved answer listing several values is one proposal carrying the rest, for a list that takes several picks", () => {
  const label = "I am working towards a degree in the following discipline: Choose all that apply";
  const saved = { ...profile, answers: [{ question: label, answer: "Other Program; Computer Science" }] };
  const [proposal] = proposals([field(label, { kind: "combobox" })], saved);
  assert.equal(proposal.value, "Other Program");
  assert.deepEqual(proposal.also, ["Computer Science"]);
  // A list that takes one pick picks the first of these its options have.
  assert.deepEqual(proposal.choices, ["Computer Science"]);
  // So is a list whose options the fill has already read (live: 35 read, and
  // only the first value was picked).
  const read = proposals([field(label, { kind: "combobox", options: ["Accounting", "Computer Science", "Other Program", "Physics"] })], saved)[0];
  assert.equal(read?.value, "Other Program");
  assert.deepEqual(read?.also, ["Computer Science"]);
  // One value stays as it was, with nothing extra.
  const single = proposals([field(label, { kind: "combobox" })], { ...profile, answers: [{ question: label, answer: "Computer Science" }] })[0];
  assert.equal(single.value, "Computer Science");
  assert.equal(single.also, undefined);
});

test("an ADP Workforce Now short job link, which opens ADP's sign-in, is tracked at the job's public career-center page", () => {
  assert.equal(
    publicPostingUrl("https://workforcenow.adp.com/job?cid=11111111-2222-3333-4444-555555555555&jobId=9200000000001_1"),
    "https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=11111111-2222-3333-4444-555555555555&jobId=9200000000001_1&lang=en_US",
  );
  const career = "https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=11111111-2222-3333-4444-555555555555&jobId=9200000000001_1&lang=en_US";
  assert.equal(publicPostingUrl(career), career);
  assert.equal(publicPostingUrl("https://jobs.lever.co/acme/123"), "https://jobs.lever.co/acme/123");
});

test("a UKG Pro sign-in link (the application page in its returnUrl) and its application page are tracked at the job's public OpportunityDetail page", () => {
  const board = "https://recruiting2.ultipro.com/ACM1000ACME/JobBoard/11111111-2222-3333-4444-555555555555";
  const detail = `${board}/OpportunityDetail?opportunityId=66666666-7777-8888-9999-000000000000`;
  assert.equal(
    publicPostingUrl("https://recruiting2.ultipro.com/ACM1000ACME/AuthCode/Register?state=returnUrl%3D%2FACM1000ACME%2FJobBoard%2F11111111-2222-3333-4444-555555555555%2FOpportunityApply%3FopportunityId%3D66666666-7777-8888-9999-000000000000%7Cta%3DACM1000ACME"),
    detail,
  );
  assert.equal(publicPostingUrl(`${board}/OpportunityApply?opportunityId=66666666-7777-8888-9999-000000000000`), detail);
  assert.equal(publicPostingUrl(detail), detail);
});

test("a UKG Pro 'if you are under the age of 18, list your age' question is answered N/A for an adult and left without proof", () => {
  const label = "If you are under the age of 18, please list your age. If not applicable, enter N/A.";
  const ask = (given: typeof profile) => proposals([field(label, { kind: "textarea", options: [] })], given)[0]?.value;
  assert.equal(ask({ ...profile, dateOfBirth: "", age18OrOlder: "Yes" }), "N/A");
  assert.equal(ask({ ...profile, dateOfBirth: "1990-01-01", age18OrOlder: "" }), "N/A");
  assert.equal(ask({ ...profile, dateOfBirth: "", age18OrOlder: "" }), undefined);
  assert.equal(ask({ ...profile, dateOfBirth: "", age18OrOlder: "No" }), undefined);
});

// Apple's gauges: "<Skill> Skill Proficiency Levels", options "1-Beginner" to
// "5-Expert", optional. Answered from the profile's skill level only when
// filling levels is on, by the skill's name or a well-known alias.
test("a skill proficiency gauge takes the profile skill's level only when filling levels is on", () => {
  const options = ["1-Beginner", "2-Basic", "3-Proficient", "4-Advanced", "5-Expert"];
  const gauge = (name: string) =>
    field(name, { kind: "radio", required: false, options, question: "Skill Proficiency Levels", section: "Skill Proficiency Levels" });
  const withSkills = (on: boolean, extra: string[] = []) =>
    profileSchema.parse({
      ...profile,
      skills: ["Python", "C#", "JavaScript", "CSS", "C", "Pandas", "REST APIs", ...extra],
      skillLevels: { Python: 4, "C#": 2, JavaScript: 3, CSS: 5, C: 1, Pandas: 3, "REST APIs": 2, ...(extra.length ? { Git: 4 } : {}) },
      fillSkillLevels: on,
    });
  const on = withSkills(true);
  assert.equal(deterministicAnswer(gauge("Python"), on), "4-Advanced");
  assert.equal(deterministicAnswer(gauge("python"), on), "4-Advanced");
  assert.equal(deterministicAnswer(gauge("Python Programming"), on), "4-Advanced");
  assert.equal(deterministicAnswer(gauge("Microsoft C-SHARP"), on), "2-Basic");
  assert.equal(deterministicAnswer(gauge("Javascript"), on), "3-Proficient");
  assert.equal(deterministicAnswer(gauge("Cascading Style Sheets"), on), "5-Expert");
  assert.equal(deterministicAnswer(gauge("C Programming Language"), on), "1-Beginner");
  assert.equal(deterministicAnswer(gauge("pandas"), on), "3-Proficient");
  assert.equal(deterministicAnswer(gauge("API"), on), "2-Basic");
  // A name in brackets after the skill, and the British spelling, are the same skill.
  const more = profileSchema.parse({ ...on, skills: [...on.skills, "Augmented Reality (AR)", "Deep Learning", "Data Modeling"],
    skillLevels: { ...on.skillLevels, "Augmented Reality (AR)": 3, "Deep Learning": 2, "Data Modeling": 4 } });
  assert.equal(deterministicAnswer(gauge("Augmented Reality"), more), "3-Proficient");
  assert.equal(deterministicAnswer(gauge("DL"), more), "2-Basic");
  assert.equal(deterministicAnswer(gauge("Data Modelling"), more), "4-Advanced");
  // Never guessed: a skill the profile lacks, and Version Control without Git.
  assert.equal(deterministicAnswer(gauge("Rust"), on), undefined);
  assert.equal(deterministicAnswer(gauge("Version Control"), on), undefined);
  assert.equal(deterministicAnswer(gauge("Version Control"), withSkills(true, ["Git"])), "4-Advanced");
  // A listed skill with no level is left, and so is everything when off.
  assert.equal(deterministicAnswer(gauge("Python"), profileSchema.parse({ ...on, skillLevels: {} })), undefined);
  assert.equal(deterministicAnswer(gauge("Python"), withSkills(false)), undefined);
});

// ADP Workforce Now's Voluntary Self-ID: react-select lists whose options load
// only when opened. Gender words it "Man/Male"; the lone "Ethnicity" list is the
// Hispanic-or-not question; "Race" holds the groups.
test("open-on-click self-ID lists: Man/Male, a lone Ethnicity as Hispanic or not, Race from the profile", () => {
  const who = profileSchema.parse({ ...profile, gender: "Male", ethnicity: "South Asian", hispanic: "No" });
  const ask = (label: string, p = who) => proposals([field(label, { kind: "combobox", options: [] })], p)[0];
  assert.ok(ask("Gender")!.choices?.includes("Man/Male"));
  assert.ok(ask("Gender", profileSchema.parse({ ...who, gender: "Female" }))!.choices?.includes("Woman/Female"));
  const ethnicity = ask("Ethnicity")!;
  assert.equal(ethnicity.value, "Not Hispanic or Latino");
  assert.ok(ethnicity.choices?.includes("Not Hispanic or Latino"));
  assert.equal(ask("Ethnicity", profileSchema.parse({ ...who, ethnicity: "Hispanic/Latinx", hispanic: "Yes" }))!.value, "Hispanic or Latino");
  assert.ok(ask("Race")!.choices?.includes("Asian"));
});
