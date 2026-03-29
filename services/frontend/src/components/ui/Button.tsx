"use client";

import type { ButtonHTMLAttributes, PropsWithChildren } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'sm' | 'md';

export default function Button({
  children,
  variant = 'primary',
  size = 'md',
  className = '',
  type = 'button',
  ...props
}: PropsWithChildren<
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: Variant;
    size?: Size;
  }
>) {
  const base =
    'inline-flex max-w-full items-center justify-center rounded-xl font-extrabold text-center leading-tight transition focus:outline-none focus:ring-2 focus:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-60';

  const sizes = size === 'sm' ? 'min-h-9 px-3 py-2 text-sm' : 'min-h-10 px-4 py-2.5 text-sm';

  const variants: Record<Variant, string> = {
    primary: 'bg-accent text-white hover:bg-accent/90',
    secondary: 'bg-surface2 text-text border border-border hover:bg-surface2/80',
    danger: 'bg-danger text-white hover:bg-danger/90',
    ghost: 'bg-transparent text-text hover:bg-surface2/80'
  };

  return (
    <button type={type} className={`${base} ${sizes} ${variants[variant]} ${className}`} {...props}>
      {children}
    </button>
  );
}
