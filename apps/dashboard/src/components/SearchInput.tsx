import type { InputHTMLAttributes } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/format";

export function SearchInput({
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={cn("relative block min-w-0", className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden />
      <input
        type="search"
        className="form-control h-11 w-full rounded-control border border-border bg-panel py-2 pl-10 pr-3 text-body outline-none transition-colors duration-hover placeholder:text-faint focus:border-orange"
        {...rest}
      />
    </label>
  );
}
