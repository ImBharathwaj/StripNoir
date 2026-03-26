"use client";

import type { InputHTMLAttributes } from 'react';

export default function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`h-10 w-full rounded-xl border border-border bg-surface2 px-3 text-sm text-text placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/60 ${className}`}
      {...props}
    />
  );
}

