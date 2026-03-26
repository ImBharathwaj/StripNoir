"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { register } from "../../../lib/authApi";
import Button from "../../../components/ui/Button";
import Input from "../../../components/ui/Input";
import { Card, CardBody, CardHeader } from "../../../components/ui/Card";

export default function RegisterUserPage() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await register({
        displayName,
        email,
        username: username || undefined,
        password
      });
      router.replace("/me");
    } catch (err: any) {
      setError(err?.body?.error || err?.message || "register failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4 py-8">
      <Card>
        <CardHeader>
          <h1 className="m-0 text-xl font-black text-text">Create user account</h1>
          <p className="mt-1 text-sm text-muted">Fan account — follow, subscribe, unlock.</p>
        </CardHeader>
        <CardBody>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div>
              <label htmlFor="reg-user-display" className="mb-1 block text-xs font-bold text-muted">
                Display name
              </label>
              <Input id="reg-user-display" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
            </div>
            <div>
              <label htmlFor="reg-user-email" className="mb-1 block text-xs font-bold text-muted">
                Email
              </label>
              <Input id="reg-user-email" value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
            </div>
            <div>
              <label htmlFor="reg-user-username" className="mb-1 block text-xs font-bold text-muted">
                Username (optional)
              </label>
              <Input id="reg-user-username" value={username} onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div>
              <label htmlFor="reg-user-password" className="mb-1 block text-xs font-bold text-muted">
                Password
              </label>
              <Input
                id="reg-user-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                autoComplete="new-password"
                required
              />
            </div>
            {error ? (
              <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm font-bold text-danger" role="alert">
                {error}
              </div>
            ) : null}
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "Creating…" : "Create account"}
            </Button>
          </form>
          <p className="mt-4 text-center text-sm text-muted">
            Creator instead?{" "}
            <Link href="/register/creator" className="font-bold text-accent underline">
              Register as creator
            </Link>
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
