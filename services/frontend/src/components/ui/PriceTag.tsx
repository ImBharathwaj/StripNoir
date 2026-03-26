"use client";

import Badge from './Badge';

export default function PriceTag({ credits }: { credits: number }) {
  return <Badge variant="accent">{credits} credits / period</Badge>;
}

