"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAppSession } from "../../context/AppSessionContext";
import { apiPut } from "../../lib/apiClient";
import { loadTokens } from "../../lib/tokenStore";
import { uploadUserMedia } from "../../lib/mediaUpload";
import { displayableMediaUrl } from "../../lib/publicMediaUrl";
import Button from "../../components/ui/Button";
import Input from "../../components/ui/Input";
import Badge from "../../components/ui/Badge";
import { Card, CardBody, CardHeader } from "../../components/ui/Card";

const inputAreaClass =
  "min-h-[88px] w-full rounded-xl border border-border bg-surface2 px-3 py-2 text-sm text-white placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/60";

export default function MePage() {
  const router = useRouter();
  const { user, creatorProfile, isCreator, loading, refresh } = useAppSession();
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [bio, setBio] = useState("");
  const [stageName, setStageName] = useState("");
  const [creatorAbout, setCreatorAbout] = useState("");
  const [categoryTags, setCategoryTags] = useState("");
  const [subscriptionPrice, setSubscriptionPrice] = useState("0");
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [chatEnabled, setChatEnabled] = useState(false);
  const [videoCallEnabled, setVideoCallEnabled] = useState(false);
  const [isNsfw, setIsNsfw] = useState(false);
  /** Saved on server (after refresh). */
  const [savedAvatarUrl, setSavedAvatarUrl] = useState<string | null>(null);
  /** Local file chosen; uploaded only on Save profile. */
  const [avatarDraftFile, setAvatarDraftFile] = useState<File | null>(null);
  const [previewObjectUrl, setPreviewObjectUrl] = useState<string | null>(null);
  const previewObjectUrlRef = useRef<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [creatorSaving, setCreatorSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [creatorError, setCreatorError] = useState<string | null>(null);
  const [creatorOk, setCreatorOk] = useState<string | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);

  useEffect(() => {
    if (!loading && !user && !loadTokens()?.accessToken) {
      router.replace("/login");
    }
  }, [loading, user, router]);

  useEffect(() => {
    if (!user) return;
    setDisplayName(user.displayName || "");
    setUsername(user.username || "");
    setBio(user.bio || "");
    setSavedAvatarUrl(user.avatarUrl || null);
  }, [user]);

  useEffect(() => {
    if (!creatorProfile) return;
    setStageName(creatorProfile.stageName || "");
    setCreatorAbout(creatorProfile.about || "");
    setCategoryTags(creatorProfile.categoryTags?.join(", ") || "");
    setSubscriptionPrice(String(creatorProfile.defaultSubscriptionPriceCredits ?? 0));
    setLiveEnabled(Boolean(creatorProfile.liveEnabled));
    setChatEnabled(Boolean(creatorProfile.chatEnabled));
    setVideoCallEnabled(Boolean(creatorProfile.videoCallEnabled));
    setIsNsfw(Boolean(creatorProfile.isNsfw));
  }, [creatorProfile]);

  useEffect(() => {
    return () => {
      if (previewObjectUrlRef.current) {
        URL.revokeObjectURL(previewObjectUrlRef.current);
        previewObjectUrlRef.current = null;
      }
    };
  }, []);

  function revokePreview() {
    if (previewObjectUrlRef.current) {
      URL.revokeObjectURL(previewObjectUrlRef.current);
      previewObjectUrlRef.current = null;
    }
    setPreviewObjectUrl(null);
  }

  function onPickAvatar(file: File | null) {
    setError(null);
    setOk(null);
    revokePreview();
    setAvatarDraftFile(null);
    if (!file) {
      setFileInputKey((k) => k + 1);
      return;
    }
    if (!file.type.startsWith("image/")) {
      setError("Profile photo must be an image.");
      return;
    }
    const url = URL.createObjectURL(file);
    previewObjectUrlRef.current = url;
    setPreviewObjectUrl(url);
    setAvatarDraftFile(file);
  }

  async function onSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setOk(null);
    const hadNewPhoto = Boolean(avatarDraftFile);
    try {
      let avatarUrl: string | undefined;
      if (avatarDraftFile) {
        const up = await uploadUserMedia(avatarDraftFile, "image");
        avatarUrl = up.publicUrl;
      }
      await apiPut("/users/me", {
        displayName: displayName.trim() || undefined,
        username: username.trim() ? username.trim().toLowerCase() : undefined,
        bio: bio.trim(),
        ...(avatarUrl !== undefined ? { avatarUrl } : {})
      });
      revokePreview();
      setAvatarDraftFile(null);
      if (avatarUrl !== undefined) setSavedAvatarUrl(avatarUrl);
      await refresh();
      setOk(hadNewPhoto ? "Profile and photo saved." : "Profile saved.");
    } catch (e: any) {
      setError(e?.body?.error || e?.message || "save failed");
    } finally {
      setSaving(false);
    }
  }

  async function onSaveCreatorSettings(e: React.FormEvent) {
    e.preventDefault();
    setCreatorSaving(true);
    setCreatorError(null);
    setCreatorOk(null);
    try {
      const tags = categoryTags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);

      await apiPut("/creators/me", {
        stageName: stageName.trim() || null,
        about: creatorAbout.trim() || null,
        categoryTags: tags,
        defaultSubscriptionPriceCredits: Math.max(0, Number(subscriptionPrice) || 0),
        isNsfw,
        liveEnabled,
        chatEnabled,
        videoCallEnabled
      });
      await refresh();
      setCreatorOk("Creator settings saved.");
    } catch (e: any) {
      setCreatorError(e?.body?.error || e?.message || "save failed");
    } finally {
      setCreatorSaving(false);
    }
  }

  const displayPhotoSrc = previewObjectUrl || displayableMediaUrl(savedAvatarUrl) || savedAvatarUrl || undefined;

  if (loading || (!user && loadTokens()?.accessToken)) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center text-muted">
        <p className="font-bold">Loading your profile…</p>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-6 lg:px-8">
      <div className="relative overflow-hidden rounded-[32px] border border-border bg-surface shadow-card">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(37,99,235,0.24),transparent_34%),radial-gradient(circle_at_bottom_right,rgba(52,211,153,0.14),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.04),transparent)]" />
        <div className="relative flex flex-wrap items-start justify-between gap-6 px-6 py-8 md:px-8 md:py-10">
          <div className="max-w-2xl">
            <div className="text-[11px] font-black uppercase tracking-[0.22em] text-muted">
              {isCreator ? "Creator Identity" : "Account"}
            </div>
            <h1 className="mt-3 text-4xl font-black tracking-[-0.04em] text-text md:text-5xl">
              {displayName || user.displayName || "Your profile"}
            </h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-muted">
              {isCreator
                ? "Manage your fan identity and creator controls from one premium workspace."
                : "Update your public profile, display photo, and account details."}
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Badge>{isCreator ? "Creator account" : "Fan account"}</Badge>
              {user.username ? <Badge variant="accent">@{user.username}</Badge> : null}
              {creatorProfile?.verificationStatus ? <Badge variant="success">{creatorProfile.verificationStatus}</Badge> : null}
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            {isCreator ? (
              <Link
                href="/creator"
                className="rounded-2xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm font-extrabold text-accent hover:bg-accent/20"
              >
                Open studio
              </Link>
            ) : (
              <Link
                href="/register/creator"
                className="rounded-2xl border border-border bg-surface2 px-4 py-3 text-sm font-extrabold text-text hover:bg-surface2/80"
              >
                Become a creator
              </Link>
            )}
          </div>
        </div>
      </div>

      <div className={`mt-6 grid gap-6 ${isCreator ? "xl:grid-cols-[1.1fr_0.9fr]" : "max-w-3xl"}`}>
        <Card className="overflow-hidden rounded-[28px] border-border/90">
          <CardHeader>
            <h2 className="m-0 text-sm font-black uppercase tracking-[0.18em] text-muted">Public Profile</h2>
            <p className="mt-2 text-sm text-muted">Photo uploads are applied when you save your profile.</p>
          </CardHeader>
          <CardBody>
            <form onSubmit={onSaveProfile} className="flex flex-col gap-6">
              <div className="grid gap-6 md:grid-cols-[180px_minmax(0,1fr)]">
                <div className="flex flex-col items-center gap-3 rounded-3xl border border-border bg-surface2/70 p-5 text-center">
                  <div className="relative h-36 w-36 overflow-hidden rounded-full border border-border bg-surface">
                    {displayPhotoSrc ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={displayPhotoSrc} alt="" className="h-full w-full rounded-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center px-2 text-center text-xs font-bold text-muted">
                        No photo
                      </div>
                    )}
                    {avatarDraftFile ? (
                      <span className="absolute bottom-2 left-2 right-2 rounded-md bg-accent/90 px-1 py-1 text-center text-[10px] font-extrabold text-white">
                        Pending save
                      </span>
                    ) : null}
                  </div>
                  <div className="text-xs text-muted">Display picture</div>
                </div>

                <div className="flex flex-col gap-5">
                  <label className="block">
                    <span className="mb-1 block text-xs font-bold uppercase tracking-[0.16em] text-muted">Upload photo</span>
                    <input
                      key={fileInputKey}
                      type="file"
                      accept="image/*"
                      disabled={saving}
                      className="text-sm text-muted file:mr-2 file:rounded-xl file:border-0 file:bg-accent file:px-4 file:py-2.5 file:text-xs file:font-extrabold file:text-white"
                      onChange={(ev) => onPickAvatar(ev.target.files?.[0] || null)}
                    />
                  </label>
                  {avatarDraftFile ? (
                    <button
                      type="button"
                      className="w-fit text-xs font-bold text-muted underline hover:text-text"
                      onClick={() => onPickAvatar(null)}
                    >
                      Discard unsaved photo
                    </button>
                  ) : savedAvatarUrl ? (
                    <a
                      href={displayableMediaUrl(savedAvatarUrl) || savedAvatarUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="w-fit text-xs font-bold text-accent underline"
                    >
                      Open current photo
                    </a>
                  ) : null}

                  <div className="grid gap-4">
                    <div>
                      <label htmlFor="me-display" className="mb-1 block text-xs font-bold uppercase tracking-[0.16em] text-muted">
                        Display name
                      </label>
                      <Input id="me-display" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
                    </div>
                    <div>
                      <label htmlFor="me-user" className="mb-1 block text-xs font-bold uppercase tracking-[0.16em] text-muted">
                        Username
                      </label>
                      <Input
                        id="me-user"
                        value={username}
                        onChange={(e) => setUsername(e.target.value.replace(/\s+/g, "").toLowerCase())}
                        placeholder="handle"
                      />
                    </div>
                    <div>
                      <label htmlFor="me-bio" className="mb-1 block text-xs font-bold uppercase tracking-[0.16em] text-muted">
                        Bio
                      </label>
                      <textarea
                        id="me-bio"
                        value={bio}
                        onChange={(e) => setBio(e.target.value)}
                        className={inputAreaClass}
                        rows={4}
                        placeholder="A short line about you"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {error ? <p className="text-sm font-bold text-danger">{error}</p> : null}
              {ok ? <p className="text-sm font-bold text-accent">{ok}</p> : null}
              <Button type="submit" disabled={saving}>
                {saving ? (avatarDraftFile ? "Uploading photo & saving…" : "Saving…") : "Save profile"}
              </Button>
            </form>
          </CardBody>
        </Card>

        {isCreator ? (
          <Card className="overflow-hidden rounded-[28px] border-border/90">
            <CardHeader>
              <h2 className="m-0 text-sm font-black uppercase tracking-[0.18em] text-muted">Creator Settings</h2>
              <p className="mt-2 text-sm text-muted">Control availability, content mode, and creator-facing profile details from here.</p>
            </CardHeader>
            <CardBody>
              <form onSubmit={onSaveCreatorSettings} className="space-y-6">
                <div className="grid gap-4">
                  <div>
                    <label className="mb-1 block text-xs font-bold uppercase tracking-[0.16em] text-muted">Stage name</label>
                    <Input value={stageName} onChange={(e) => setStageName(e.target.value)} required />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-bold uppercase tracking-[0.16em] text-muted">Creator bio</label>
                    <textarea
                      value={creatorAbout}
                      onChange={(e) => setCreatorAbout(e.target.value)}
                      className={inputAreaClass}
                      rows={4}
                      placeholder="Describe your creator identity"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-bold uppercase tracking-[0.16em] text-muted">Category tags</label>
                    <Input value={categoryTags} onChange={(e) => setCategoryTags(e.target.value)} placeholder="music, fitness, lifestyle" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-bold uppercase tracking-[0.16em] text-muted">Default subscription</label>
                    <Input type="number" min={0} value={subscriptionPrice} onChange={(e) => setSubscriptionPrice(e.target.value)} />
                  </div>
                </div>

                <div className="rounded-3xl border border-border bg-surface2/60 p-4">
                  <div className="text-xs font-bold uppercase tracking-[0.16em] text-muted">Availability</div>
                  <div className="mt-4 grid gap-3">
                    <label className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-4 py-3">
                      <div>
                        <div className="text-sm font-black text-text">Live</div>
                        <div className="text-xs text-muted">Allow live sessions on your public profile.</div>
                      </div>
                      <input type="checkbox" checked={liveEnabled} onChange={(e) => setLiveEnabled(e.target.checked)} className="h-5 w-5" />
                    </label>
                    <label className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-4 py-3">
                      <div>
                        <div className="text-sm font-black text-text">Chat</div>
                        <div className="text-xs text-muted">Let fans start private direct chat with you.</div>
                      </div>
                      <input type="checkbox" checked={chatEnabled} onChange={(e) => setChatEnabled(e.target.checked)} className="h-5 w-5" />
                    </label>
                    <label className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-4 py-3">
                      <div>
                        <div className="text-sm font-black text-text">Video calls</div>
                        <div className="text-xs text-muted">Accept 1:1 video call requests from fans.</div>
                      </div>
                      <input type="checkbox" checked={videoCallEnabled} onChange={(e) => setVideoCallEnabled(e.target.checked)} className="h-5 w-5" />
                    </label>
                    <label className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-4 py-3">
                      <div>
                        <div className="text-sm font-black text-text">NSFW mode</div>
                        <div className="text-xs text-muted">Mark this creator profile as adult-oriented content.</div>
                      </div>
                      <input type="checkbox" checked={isNsfw} onChange={(e) => setIsNsfw(e.target.checked)} className="h-5 w-5" />
                    </label>
                  </div>
                </div>

                {creatorError ? <p className="text-sm font-bold text-danger">{creatorError}</p> : null}
                {creatorOk ? <p className="text-sm font-bold text-accent">{creatorOk}</p> : null}
                <Button type="submit" disabled={creatorSaving}>
                  {creatorSaving ? "Saving creator settings…" : "Save creator settings"}
                </Button>
              </form>
            </CardBody>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
