"use client";

import type { HTMLAttributes, PropsWithChildren } from 'react';

type Variant = 'default' | 'success' | 'warning' | 'danger' | 'accent';

export default function Badge({
  children,
  variant = 'default',
  className = '',
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLSpanElement> & {
    variant?: Variant;
  }
>) {
  const variants: Record<Variant, string> = {
    default: 'bg-surface2 text-text',
    success: 'bg-success/20 text-success',
    warning: 'bg-warning/20 text-warning',
    danger: 'bg-danger/20 text-danger',
    accent: 'bg-accent/20 text-accent'
  };

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-extrabold ${variants[variant]} ${className}`}
      {...props}
    >
      {children}
    </span>
  );
}

