import { Check, ChevronDown } from "lucide-react";
import { useId, useMemo, useState } from "react";

export type ModelComboboxOption = {
  value: string;
  label?: string;
};

type Props = {
  options: ModelComboboxOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  required?: boolean;
};

export function ModelCombobox({ options, value, onChange, placeholder, ariaLabel = "模型 ID", required }: Props) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const filtered = useMemo(() => {
    const keyword = value.trim().toLowerCase();
    const unique = [...new Map(options.map((option) => [option.value, option])).values()];
    if (!keyword || unique.some((option) => option.value === value)) return unique;
    return unique.filter((option) => `${option.label ?? ""} ${option.value}`.toLowerCase().includes(keyword));
  }, [options, value]);

  return (
    <div className="model-combobox" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
    }}>
      <div className="model-combobox-control">
        <input
          required={required}
          role="combobox"
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          value={value}
          onFocus={() => { if (options.length > 0) setOpen(true); }}
          onChange={(event) => { onChange(event.target.value); setOpen(true); }}
          placeholder={placeholder}
        />
        <button
          type="button"
          aria-label="展开模型列表"
          aria-expanded={open}
          disabled={options.length === 0}
          onClick={() => setOpen((current) => !current)}
        >
          <ChevronDown size={16} />
        </button>
      </div>
      {open && options.length > 0 && (
        <div className="model-combobox-list" id={listId} role="listbox" aria-label="可用模型">
          {filtered.length > 0 ? filtered.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={option.value === value ? "active" : ""}
              key={option.value}
              onClick={() => { onChange(option.value); setOpen(false); }}
            >
              <span>{option.label || option.value}</span>
              {option.label && option.label !== option.value && <small>{option.value}</small>}
              {option.value === value && <Check size={14} />}
            </button>
          )) : <div className="model-combobox-empty">没有匹配项，可继续手动填写模型 ID</div>}
        </div>
      )}
    </div>
  );
}
