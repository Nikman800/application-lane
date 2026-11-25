import React, { useState } from "react";
import { createRoot } from "react-dom/client";

// A stand-in for the single-selects ADP's Voluntary Self-ID draws with
// react-select (classNamePrefix "MDFSelectBox"): the options load only when
// the menu opens, and the Race list is drawn only once Ethnicity holds an answer.
type Option = { label: string; value: string };

class Select extends React.Component<{
  id: string;
  name: string;
  options: Option[];
  value?: Option;
  onMenuOpen: () => void;
  onChange: (value: Option) => void;
}> {
  selectOption(option: Option) {
    (window as any).selfIdPicks.push(`${this.props.name}: ${option.label}`);
    this.props.onChange(option);
  }
  render() {
    const { value, id } = this.props;
    return (
      <div className="css-b62m3t-container">
        <div className="MDFSelectBox__control css-13cymwt-control">
          <div className="MDFSelectBox__value-container MDFSelectBox__value-container--has-value css-hlgwow">
            {value ? <div className="MDFSelectBox__single-value">{value.label}</div> : <div className="MDFSelectBox__placeholder">Select...</div>}
            <div className="MDFSelectBox__input-container">
              <input className="MDFSelectBox__input" id={id} type="text" role="combobox" aria-autocomplete="list"
                aria-expanded="false" aria-haspopup="true" autoComplete="off" value="" onChange={() => {}} />
            </div>
          </div>
        </div>
      </div>
    );
  }
}

const list = (labels: string[]) => labels.map((label) => ({ label, value: label }));
const choices: Record<string, Option[]> = {
  Gender: list(["Man/Male", "Prefer not to say", "Woman/Female"]),
  Ethnicity: list(["Hispanic or Latino", "Not Hispanic or Latino"]),
  Race: list(["American Indian or Alaska Native", "Asian", "Black or African American", "Native Hawaiian or Other Pacific Islander", "Two or more races (Not Hispanic or Latino)", "White"]),
};

function Field({ name, id, onPick }: { name: string; id: string; onPick?: () => void }) {
  const [options, setOptions] = useState<Option[]>([]);
  const [value, setValue] = useState<Option>();
  (window as any).selfId[name] = value?.label || "";
  return (
    <Select id={id} name={name} options={options} value={value}
      onMenuOpen={() => setOptions(choices[name])}
      onChange={(picked) => { setValue(picked); onPick?.(); }} />
  );
}

function App() {
  const [asked, setAsked] = useState(false);
  return (
    <>
      <div className="qMainDiv"><label htmlFor="vsidGender">Gender</label><Field name="Gender" id="vsidGender" /></div>
      <div className="qMainDiv"><label htmlFor="vsidEthinicity">Ethnicity</label><Field name="Ethnicity" id="vsidEthinicity" onPick={() => setAsked(true)} /></div>
      {asked && <div className="qMainDiv"><label htmlFor="vsidRace">Race</label><Field name="Race" id="vsidRace" /></div>}
    </>
  );
}

(window as any).selfIdPicks = [];
(window as any).selfId = {};
createRoot(document.getElementById("selfIdRoot")!).render(<App />);
