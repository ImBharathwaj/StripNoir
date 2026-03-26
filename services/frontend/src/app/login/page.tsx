"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { login } from "../../lib/authApi";
import Button from "../../components/ui/Button";
import Input from "../../components/ui/Input";
import { Card, CardBody, CardHeader } from "../../components/ui/Card";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await login({ email, password });
      router.replace("/me");
    } catch (err: any) {
      setError(err?.body?.error || err?.message || "login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4 py-8">
      <Card>
        <CardHeader>
          <h1 className="m-0 text-xl font-black text-text">Sign in</h1>
          <p className="mt-1 text-sm text-muted">Welcome back to StripNoir.</p>
        </CardHeader>
        <CardBody>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div>
              <label htmlFor="login-email" className="mb-1 block text-xs font-bold text-muted">
                Email
              </label>
              <Input
                id="login-email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                type="email"
                autoComplete="email"
                required
              />
            </div>
            <div>
              <label htmlFor="login-password" className="mb-1 block text-xs font-bold text-muted">
                Password
              </label>
              <Input
                id="login-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                autoComplete="current-password"
                required
              />
            </div>
            {error ? (
              <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm font-bold text-danger" role="alert">
                {error}
              </div>
            ) : null}
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </form>
          <p className="mt-4 text-center text-sm text-muted">
            No account?{" "}
            <Link href="/register" className="font-bold text-accent underline">
              Register
            </Link>
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
