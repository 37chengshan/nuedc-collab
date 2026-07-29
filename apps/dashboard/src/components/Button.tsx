import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/format";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-orange text-ink hover:brightness-95 active:scale-[0.98] shadow-soft",
  secondary:
    "bg-surface text-body border border-border hover:bg-muted active:scale-[0.98]",
  ghost: "bg-transparent text-body hover:bg-muted active:scale-[0.98]",
  danger: "bg-danger text-white hover:opacity-90 active:scale-[0.98]",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-9 px-3 text-sm",
  md: "h-11 px-4 text-sm",
  lg: "h-12 px-5 text-base",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  className,
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  leftIcon,
  rightIcon,
  children,
  type = "button",
  ...rest
}, ref) {
  return (
    <button
      type={type}
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-control font-medium transition-all duration-press touch-target",
        VARIANT[variant],
        SIZE[size],
        (disabled || loading) && "pointer-events-none opacity-55",
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent" /> : leftIcon}
      <span>{children}</span>
      {!loading && rightIcon}
    </button>
  );
});
