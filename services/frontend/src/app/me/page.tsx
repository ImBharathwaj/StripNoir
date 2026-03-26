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
import { Card, CardBody, CardHeader } from "../../components/ui/Card";

const inputAreaClass =
  "min-h-[88px] w-full rounded-xl border border-border bg-surface2 px-3 py-2 text-sm text-white placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/60";

export default function MePage() {
  const router = useRouter();
  const { user, isCreator, loading, refresh } = useAppSession();
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [bio, setBio] = useState("");
  /** Saved on server (after refresh). */
  const [savedAvatarUrl, setSavedAvatarUrl] = useState<string | null>(null);
  /** Local file chosen; uploaded only on Save profile. */
  const [avatarDraftFile, setAvatarDraftFile] = useState<File | null>(null);
  const [previewObjectUrl, setPreviewObjectUrl] = useState<string | null>(null);
  const previewObjectUrlRef = useRef<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
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
    <div className="mx-auto max-w-lg px-4 py-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black text-text">Your profile</h1>
          <p className="mt-1 text-sm text-muted">Fan account — name, bio, and photo.</p>
        </div>
        {isCreator ? (
          <Link
            href="/creator"
            className="shrink-0 rounded-xl border border-accent/40 bg-accent/10 px-3 py-2 text-xs font-extrabold text-accent hover:bg-accent/20"
          >
            Open studio
          </Link>
        ) : (
          <Link
            href="/register/creator"
            className="shrink-0 rounded-xl border border-border bg-surface2 px-3 py-2 text-xs font-extrabold text-text hover:bg-surface2/80"
          >
            Become a creator
          </Link>
        )}
      </div>

      <Card>
        <CardHeader>
          <h2 className="m-0 text-sm font-black text-text">Profile</h2>
          <p className="mt-1 text-xs text-muted">Photo uploads when you click Save profile.</p>
        </CardHeader>
        <CardBody>
          <form onSubmit={onSaveProfile} className="flex flex-col gap-6">
            <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
              <div className="relative h-28 w-28 shrink-0 overflow-hidden rounded-full border border-border bg-surface2">
                {displayPhotoSrc ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={displayPhotoSrc} alt="" className="h-full w-full rounded-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center px-2 text-center text-xs font-bold text-muted">
                    No photo
                  </div>
                )}
                {avatarDraftFile ? (
                  <span className="absolute bottom-1 left-1 right-1 rounded-md bg-accent/90 px-1 py-0.5 text-center text-[10px] font-extrabold text-white">
                    Not saved yet
                  </span>
                ) : null}
              </div>
              <div className="min-w-0 flex-1">
                <label className="block">
                  <span className="mb-1 block text-xs font-bold text-muted">Display picture</span>
                  <input
                    key={fileInputKey}
                    type="file"
                    accept="image/*"
                    disabled={saving}
                    className="text-sm text-muted file:mr-2 file:rounded-lg file:border-0 file:bg-accent file:px-3 file:py-2 file:text-xs file:font-extrabold file:text-white"
                    onChange={(ev) => onPickAvatar(ev.target.files?.[0] || null)}
                  />
                </label>
                {avatarDraftFile ? (
                  <div className="mt-2 space-y-1">
                    <p className="text-xs font-bold text-accent">
                      New photo selected — press &quot;Save profile&quot; to upload and apply it.
                    </p>
                    <button
                      type="button"
                      className="text-xs font-bold text-muted underline hover:text-text"
                      onClick={() => onPickAvatar(null)}
                    >
                      Discard unsaved photo
                    </button>
                  </div>
                ) : savedAvatarUrl ? (
                  <p className="mt-2 text-xs text-muted">
                    <a
                      href={displayableMediaUrl(savedAvatarUrl) || savedAvatarUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-bold text-accent underline"
                    >
                      Open current photo
                    </a>{" "}
                    in a new tab
                  </p>
                ) : null}
              </div>
            </div>

            <div>
              <label htmlFor="me-display" className="mb-1 block text-xs font-bold text-muted">
                Display name
              </label>
              <Input id="me-display" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
            </div>
            <div>
              <label htmlFor="me-user" className="mb-1 block text-xs font-bold text-muted">
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
              <label htmlFor="me-bio" className="mb-1 block text-xs font-bold text-muted">
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
            {error ? <p className="text-sm font-bold text-danger">{error}</p> : null}
            {ok ? <p className="text-sm font-bold text-accent">{ok}</p> : null}
            <Button type="submit" disabled={saving}>
              {saving ? (avatarDraftFile ? "Uploading photo & saving…" : "Saving…") : "Save profile"}
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
