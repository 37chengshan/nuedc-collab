import type { SelectHTMLAttributes } from "react";
import { cn } from "@/lib/format";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: string;
  error?: string;
  options: Array<{ value: string; label: string }>;
}

export function Select({ className, label, hint, error, options, id, ...rest }: SelectProps) {
  const inputId = id || rest.name || label;
  return (
    <label className="block space-y-1.5 text-sm">
      {label ? <span className="font-medium text-body">{label}</span> : null}
      <select
        id={inputId}
        className={cn(
          "form-control w-full rounded-control border border-border bg-panel px-3 py-2 text-body outline-none transition-colors duration-hover focus:border-orange",
          error && "border-danger",
          className,
        )}
        {...rest}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {error ? <span className="text-xs text-danger">{error}</span> : hint ? <span className="text-xs text-subtle">{hint}</span> : null}
    </label>
  );
}
