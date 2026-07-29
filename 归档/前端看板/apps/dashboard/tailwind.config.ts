import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}", "./test/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "var(--color-canvas)",
        sidebar: "var(--color-sidebar)",
        surface: "var(--color-surface)",
        panel: "var(--color-panel)",
        muted: "var(--color-muted)",
        border: "var(--color-border)",
        "border-strong": "var(--color-border-strong)",
        ink: "var(--color-ink)",
        body: "var(--color-body)",
        subtle: "var(--color-subtle)",
        faint: "var(--color-faint)",
        orange: {
          DEFAULT: "var(--color-orange)",
          dark: "var(--color-orange-dark)",
          soft: "var(--color-orange-soft)",
        },
        success: {
          DEFAULT: "var(--color-success)",
          soft: "var(--color-success-soft)",
        },
        warning: {
          DEFAULT: "var(--color-warning)",
          soft: "var(--color-warning-soft)",
        },
        danger: {
          DEFAULT: "var(--color-danger)",
          soft: "var(--color-danger-soft)",
        },
        info: {
          DEFAULT: "var(--color-info)",
          soft: "var(--color-info-soft)",
        },
      },
      fontFamily: {
        title: "var(--font-title)",
        body: "var(--font-body)",
        mono: "var(--font-mono)",
      },
      borderRadius: {
        control: "8px",
        panel: "12px",
        dialog: "16px",
      },
      boxShadow: {
        soft: "0 1px 2px rgba(23, 21, 19, 0.04), 0 8px 24px rgba(23, 21, 19, 0.06)",
      },
      transitionDuration: {
        press: "var(--motion-press)",
        hover: "var(--motion-hover)",
        toast: "var(--motion-toast)",
        menu: "var(--motion-menu)",
        drawer: "var(--motion-drawer)",
        page: "var(--motion-page)",
      },
    },
  },
  plugins: [],
};

export default config;
