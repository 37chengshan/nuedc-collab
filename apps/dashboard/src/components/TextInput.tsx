import type { InputHTMLAttributes } from "react";
import { cn } from "@/lib/format";

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export function TextInput({ className, label, hint, error, id, ...rest }: TextInputProps) {
  const inputId = id || rest.name || label;
  return (
    <label className="block space-y-1.5 text-sm">
      {label ? <span className="font-medium text-body">{label}</span> : null}
      <input
        id={inputId}
        className={cn(
          "form-control w-full rounded-control border border-border bg-panel px-3 py-2 text-body outline-none transition-colors duration-hover",
          "placeholder:text-faint focus:border-orange",
          error && "border-danger",
          className,
        )}
        {...rest}
      />
      {error ? <span className="text-xs text-danger">{error}</span> : hint ? <span className="text-xs text-subtle">{hint}</span> : null}
    </label>
  );
}
