"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiGet, apiPost } from "../../lib/apiClient";
import { trackEvent } from "../../lib/analytics";
import Button from "../../components/ui/Button";
import Input from "../../components/ui/Input";
import { Card, CardBody, CardHeader } from "../../components/ui/Card";
import Badge from "../../components/ui/Badge";

function readCredits(w: Record<string, unknown> | null | undefined, snake: string, camel: string): number {
  if (!w) return 0;
  const s = w[snake];
  const c = w[camel];
  const v = typeof s === "number" ? s : typeof c === "number" ? c : Number(s ?? c ?? 0);
  return Number.isFinite(v) ? v : 0;
}

export default function WalletPage() {
  const router = useRouter();

  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wallet, setWallet] = useState<Record<string, unknown> | null>(null);

  const [amountCredits, setAmountCredits] = useState("100");
  const [creatorUserId, setCreatorUserId] = useState("");
  const [tipCredits, setTipCredits] = useState("10");
  const [subscribeCreatorId, setSubscribeCreatorId] = useState("");
  const [subscribeCredits, setSubscribeCredits] = useState("10");

  async function refresh() {
    const data = await apiGet<{ wallet: Record<string, unknown> }>("/wallet/balance");
    setWallet(data.wallet || null);
  }

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setBusy(true);
      setError(null);
      try {
        await refresh();
      } catch (err: any) {
        if (err?.status === 401 || err?.message === "not authenticated") {
          router.replace("/login");
          return;
        }
        if (!cancelled) setError(err?.body?.error || err?.message || "failed to load wallet");
      } finally {
        if (!cancelled) setBusy(false);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function onDeposit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const amt = Number(amountCredits);
      await apiPost("/payments/deposit", { amountCredits: amt });
      trackEvent("deposit_credits", { amountCredits: amt, source: "wallet" });
      await refresh();
    } catch (err: any) {
      setError(err?.body?.error || err?.message || "deposit failed");
    }
  }

  async function onTip(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiPost("/payments/tip", {
        creatorUserId: creatorUserId.trim(),
        amountCredits: Number(tipCredits)
      });
      await refresh();
    } catch (err: any) {
      setError(err?.body?.error || err?.message || "tip failed");
    }
  }

  async function onSubscribe(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const cid = subscribeCreatorId.trim();
      const credits = Number(subscribeCredits);
      trackEvent("subscribe_click", { creatorId: cid, amountCredits: credits, source: "wallet" });
      await apiPost("/payments/subscribe", {
        creatorId: cid,
        amountCredits: credits
      });
      trackEvent("subscribe_success", { creatorId: cid, amountCredits: credits, source: "wallet" });
      await refresh();
    } catch (err: any) {
      setError(err?.body?.error || err?.message || "subscribe failed");
    }
  }

  const available = readCredits(wallet, "available_credits", "availableCredits");
  const held = readCredits(wallet, "held_credits", "heldCredits");

  return (
    <div className="mx-auto max-w-4xl py-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="m-0">Wallet</h1>
          <p className="mt-1 text-sm text-muted">Deposit credits, tip creators, or subscribe from your balance.</p>
        </div>
        <Link href="/creators" className="text-sm font-bold text-accent underline">
          Discover creators
        </Link>
      </div>

      {busy ? <div className="mt-4 text-muted">Loading…</div> : null}
      {error ? (
        <div className="mt-4 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 font-bold text-danger" role="alert">
          {error}
        </div>
      ) : null}

      {wallet ? (
        <Card className="mt-6">
          <CardBody className="space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-6">
              <div>
                <div className="text-sm font-black text-muted">Available credits</div>
                <div className="mt-1 text-3xl font-black text-text tabular-nums">{available}</div>
              </div>
              <div>
                <div className="text-sm font-black text-muted">Held credits</div>
                <div className="mt-1 text-xl font-black text-text tabular-nums">{held}</div>
              </div>
              <Badge variant="success">Wallet active</Badge>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Card className="border-border bg-surface2 shadow-none">
                <CardHeader className="text-sm font-black text-text">Deposit</CardHeader>
                <CardBody>
                  <form onSubmit={onDeposit} className="flex flex-col gap-3">
                    <label htmlFor="wallet-deposit-amount" className="text-xs font-bold text-muted">
                      Amount (credits)
                    </label>
                    <Input
                      id="wallet-deposit-amount"
                      value={amountCredits}
                      onChange={(e) => setAmountCredits(e.target.value)}
                      type="number"
                      min={1}
                      aria-label="Deposit amount in credits"
                    />
                    <Button type="submit">Deposit</Button>
                  </form>
                </CardBody>
              </Card>

              <Card className="border-border bg-surface2 shadow-none">
                <CardHeader className="text-sm font-black text-text">Tip creator</CardHeader>
                <CardBody>
                  <form onSubmit={onTip} className="flex flex-col gap-3">
                    <label htmlFor="wallet-tip-user" className="text-xs font-bold text-muted">
                      Creator user ID
                    </label>
                    <Input
                      id="wallet-tip-user"
                      value={creatorUserId}
                      onChange={(e) => setCreatorUserId(e.target.value)}
                      placeholder="Creator's user id"
                      required
                      aria-label="Creator user id for tip"
                    />
                    <label htmlFor="wallet-tip-amount" className="text-xs font-bold text-muted">
                      Tip (credits)
                    </label>
                    <Input
                      id="wallet-tip-amount"
                      value={tipCredits}
                      onChange={(e) => setTipCredits(e.target.value)}
                      type="number"
                      min={1}
                      aria-label="Tip amount in credits"
                    />
                    <Button type="submit">Send tip</Button>
                  </form>
                </CardBody>
              </Card>

              <Card className="border-border bg-surface2 shadow-none sm:col-span-2 lg:col-span-1">
                <CardHeader className="text-sm font-black text-text">Subscribe to creator</CardHeader>
                <CardBody>
                  <form onSubmit={onSubscribe} className="flex flex-col gap-3">
                    <label htmlFor="wallet-sub-creator" className="text-xs font-bold text-muted">
                      Creator profile ID
                    </label>
                    <Input
                      id="wallet-sub-creator"
                      value={subscribeCreatorId}
                      onChange={(e) => setSubscribeCreatorId(e.target.value)}
                      placeholder="creator_profile id"
                      required
                      aria-label="Creator profile id to subscribe"
                    />
                    <label htmlFor="wallet-sub-credits" className="text-xs font-bold text-muted">
                      Credits per period
                    </label>
                    <Input
                      id="wallet-sub-credits"
                      value={subscribeCredits}
                      onChange={(e) => setSubscribeCredits(e.target.value)}
                      type="number"
                      min={1}
                      aria-label="Subscription credits amount"
                    />
                    <Button type="submit">Subscribe</Button>
                  </form>
                </CardBody>
              </Card>
            </div>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
