import React, { useState } from "react";
import { createRoot } from "react-dom/client";

// A stand-in for the multi-select ADP's recruitment questions draw with
// react-select (classNamePrefix "MDFSelectBox", isMulti): selectOption
// toggles a pick, so choosing a held option again removes it.
type Option = { label: string; value: string };

class Select extends React.Component<{
  isMulti: boolean;
  options: Option[];
  value: Option[];
  onChange: (value: Option[]) => void;
}> {
  selectOption(option: Option) {
    const { value, onChange } = this.props;
    (window as any).mdfToggles.push(option.label);
    onChange(value.some((held) => held.value === option.value)
      ? value.filter((held) => held.value !== option.value)
      : [...value, option]);
  }
  render() {
    const { value } = this.props;
    return (
      <div className="css-b62m3t-container">
        <div className="MDFSelectBox__control css-13cymwt-control">
          <div className="MDFSelectBox__value-container MDFSelectBox__value-container--is-multi css-hlgwow">
            {!value.length && <div className="MDFSelectBox__placeholder">Choose an option</div>}
            {value.map((option) => (
              <div key={option.value} className="MDFSelectBox__multi-value">
                <div className="MDFSelectBox__multi-value__label">{option.label}</div>
              </div>
            ))}
            <div className="MDFSelectBox__input-container">
              <input className="MDFSelectBox__input" id="question_10" type="text" role="combobox" aria-autocomplete="list"
                aria-expanded="false" aria-haspopup="true" aria-required="true" autoComplete="off" value="" onChange={() => {}} />
            </div>
          </div>
        </div>
      </div>
    );
  }
}

const options = ["Employee Referral", "Facebook", "LinkedIn", "Indeed", "Glassdoor", "Zip Recruiter", "College or University", "Job Fair", "Craigslist", "Other"]
  .map((label) => ({ label, value: label }));

function App() {
  const [value, setValue] = useState<Option[]>([]);
  (window as any).mdfValue = value.map((option) => option.label);
  return <Select isMulti options={options} value={value} onChange={setValue} />;
}

(window as any).mdfToggles = [];
createRoot(document.getElementById("mdfRoot")!).render(<App />);
