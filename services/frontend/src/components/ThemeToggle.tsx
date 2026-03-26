"use client";

import { useEffect, useState } from "react";
import { applyThemeClass, getStoredTheme, THEME_STORAGE_KEY, type ThemeMode } from "../lib/themeStorage";

function readMode(): ThemeMode {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

function IconSun({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <circle cx="12" cy="12" r="3.5" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M12 2v1.25M12 20.75V22M4.22 4.22l.88.88M18.9 18.9l.88.88M2 12h1.25M20.75 12H22M4.22 19.78l.88-.88M18.9 5.1l.88-.88"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconMoon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path
        d="M21 14.5A8.5 8.5 0 0 1 9.5 3a8.5 8.5 0 1 0 11.5 11.5Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>("dark");

  useEffect(() => {
    setMode(readMode());

    function onStorage(e: StorageEvent) {
      if (e.key !== THEME_STORAGE_KEY || !e.newValue) return;
      if (e.newValue === "light" || e.newValue === "dark") {
        applyThemeClass(e.newValue);
        setMode(e.newValue);
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  function toggle() {
    const next: ThemeMode = mode === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // ignore
    }
    applyThemeClass(next);
    setMode(next);
  }

  const isDark = mode === "dark";

  return (
    <button
      type="button"
      onClick={toggle}
      className="group relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/90 bg-surface2/90 text-muted shadow-sm backdrop-blur-sm transition-all duration-300 ease-out hover:border-accent/35 hover:text-accent hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 focus-visible:ring-offset-2 focus-visible:ring-offset-bg active:scale-[0.96]"
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Light appearance" : "Dark appearance"}
    >
      <span className="relative block h-[18px] w-[18px]">
        <IconSun
          className={`absolute inset-0 text-current transition-all duration-300 ease-out ${
            isDark ? "scale-100 rotate-0 opacity-100" : "pointer-events-none scale-50 rotate-90 opacity-0"
          }`}
        />
        <IconMoon
          className={`absolute inset-0 text-current transition-all duration-300 ease-out ${
            isDark ? "pointer-events-none scale-50 -rotate-90 opacity-0" : "scale-100 rotate-0 opacity-100"
          }`}
        />
      </span>
    </button>
  );
}
