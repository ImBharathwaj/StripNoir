"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { registerCreator } from "../../../lib/authApi";
import { apiPost } from "../../../lib/apiClient";
import { useAppSession } from "../../../context/AppSessionContext";
import Button from "../../../components/ui/Button";
import Input from "../../../components/ui/Input";
import { Card, CardBody, CardHeader } from "../../../components/ui/Card";

export default function RegisterCreatorPage() {
  const router = useRouter();
  const { user, isCreator, loading: sessionLoading, refresh } = useAppSession();
  const [displayName, setDisplayName] = useState("");
  const [stageName, setStageName] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loggedInFan = Boolean(user) && !isCreator;

  useEffect(() => {
    if (sessionLoading) return;
    if (isCreator) {
      router.replace("/creator");
    }
  }, [sessionLoading, isCreator, router]);

  const fillStageFromDisplay = useCallback(() => {
    const d = displayName.trim();
    if (d && !stageName.trim()) setStageName(d);
  }, [displayName, stageName]);

  async function onSubmitNewAccount(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await registerCreator({
        displayName: displayName.trim(),
        stageName: stageName.trim() || displayName.trim(),
        email: email.trim(),
        username: username.trim() || undefined,
        password
      });
      router.replace("/creators/onboarding");
    } catch (err: any) {
      setError(err?.body?.error || err?.message || "creator registration failed");
    } finally {
      setBusy(false);
    }
  }

  async function onSubmitApplyAsCreator(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiPost("/creators/apply", {
        stageName: stageName.trim(),
        about: null,
        categoryTags: [],
        defaultSubscriptionPriceCredits: 0
      });
      await refresh();
      router.replace("/creators/onboarding");
    } catch (err: any) {
      setError(err?.body?.error || err?.message || "could not create creator profile");
    } finally {
      setBusy(false);
    }
  }

  if (sessionLoading || isCreator) {
    return (
      <div className="mx-auto flex min-h-[40vh] max-w-md items-center justify-center px-4 text-sm text-muted">
        Loading…
      </div>
    );
  }

  if (loggedInFan) {
    return (
      <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4 py-8">
        <Card>
          <CardHeader>
            <h1 className="m-0 text-xl font-black text-white">Become a creator</h1>
            <p className="mt-1 text-sm text-muted">
              Your account is a fan account today. Add a stage name to attach a creator profile to the same login.
            </p>
          </CardHeader>
          <CardBody>
            <form onSubmit={onSubmitApplyAsCreator} className="flex flex-col gap-4">
              <div>
                <label htmlFor="apply-stage" className="mb-1 block text-xs font-bold text-muted">
                  Stage name <span className="text-danger">*</span>
                </label>
                <Input
                  id="apply-stage"
                  value={stageName}
                  onChange={(e) => setStageName(e.target.value)}
                  placeholder="How fans see you"
                  required
                />
              </div>
              {error ? (
                <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm font-bold text-danger" role="alert">
                  {error}
                </div>
              ) : null}
              <Button type="submit" disabled={busy} className="w-full">
                {busy ? "Saving…" : "Create creator profile"}
              </Button>
            </form>
            <p className="mt-4 text-center text-sm text-muted">
              <Link href="/me" className="font-bold text-accent underline">
                Back to profile
              </Link>
            </p>
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-4 py-8">
      <Card>
        <CardHeader>
          <h1 className="m-0 text-xl font-black text-white">Create creator account</h1>
          <p className="mt-1 text-sm text-muted">Creates your login, creator role, and studio profile in one step—you stay signed in.</p>
        </CardHeader>
        <CardBody>
          <form onSubmit={onSubmitNewAccount} className="flex flex-col gap-4">
            <div>
              <label htmlFor="reg-creator-display" className="mb-1 block text-xs font-bold text-muted">
                Display name
              </label>
              <Input
                id="reg-creator-display"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                onBlur={fillStageFromDisplay}
                required
              />
            </div>
            <div>
              <label htmlFor="reg-creator-stage" className="mb-1 block text-xs font-bold text-muted">
                Stage name <span className="text-danger">*</span>
              </label>
              <Input
                id="reg-creator-stage"
                value={stageName}
                onChange={(e) => setStageName(e.target.value)}
                placeholder="Public creator name (can match display name)"
                required
              />
            </div>
            <div>
              <label htmlFor="reg-creator-email" className="mb-1 block text-xs font-bold text-muted">
                Email
              </label>
              <Input id="reg-creator-email" value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
            </div>
            <div>
              <label htmlFor="reg-creator-username" className="mb-1 block text-xs font-bold text-muted">
                Username (optional)
              </label>
              <Input id="reg-creator-username" value={username} onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div>
              <label htmlFor="reg-creator-password" className="mb-1 block text-xs font-bold text-muted">
                Password
              </label>
              <Input
                id="reg-creator-password"
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
              {busy ? "Creating…" : "Create creator account"}
            </Button>
          </form>
          <p className="mt-4 text-center text-sm text-muted">
            Fan account?{" "}
            <Link href="/register/user" className="font-bold text-accent underline">
              Register as user
            </Link>
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
