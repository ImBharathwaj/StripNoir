"use client";

import Badge from './Badge';

export default function CreatorBadge({ status }: { status?: string | null }) {
  const s = (status || '').toLowerCase();
  if (s === 'approved') return <Badge variant="success">Verified</Badge>;
  if (s === 'pending') return <Badge variant="warning">Pending verification</Badge>;
  if (s === 'rejected') return <Badge variant="danger">Verification rejected</Badge>;
  return <Badge>Unverified</Badge>;
}

