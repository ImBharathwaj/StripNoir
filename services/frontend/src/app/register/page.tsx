"use client";

import Link from "next/link";
import { Card, CardBody, CardHeader } from "../../components/ui/Card";

export default function RegisterPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="m-0">Register</h1>
      <p className="mt-2 text-muted">Create an account, then choose fan (User) or creator (Creator).</p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Link
          href="/register/user"
          className="group rounded-xl border border-border bg-surface2 p-5 shadow-card transition hover:border-accent/40 hover:bg-surface"
        >
          <div className="text-lg font-black text-text group-hover:text-accent">User</div>
          <p className="mt-2 text-sm text-muted">Follow creators, subscribe, and unlock content.</p>
        </Link>
        <Link
          href="/register/creator"
          className="group rounded-xl border border-border bg-surface2 p-5 shadow-card transition hover:border-accent/40 hover:bg-surface"
        >
          <div className="text-lg font-black text-text group-hover:text-accent">Creator</div>
          <p className="mt-2 text-sm text-muted">Sign up and enable a creator profile in one flow.</p>
        </Link>
      </div>

      <Card className="mt-8">
        <CardHeader className="text-sm font-bold text-muted">Already registered?</CardHeader>
        <CardBody>
          <Link href="/login" className="font-bold text-accent underline">
            Sign in
          </Link>
        </CardBody>
      </Card>
    </div>
  );
}
