"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAppSession } from "../../context/AppSessionContext";
import { apiGet, apiPost, apiPut } from "../../lib/apiClient";
import { loadTokens } from "../../lib/tokenStore";
import { uploadUserMedia } from "../../lib/mediaUpload";
import Button from "../../components/ui/Button";
import Input from "../../components/ui/Input";
import { Card, CardBody, CardHeader } from "../../components/ui/Card";

type ContentRow = {
  id: string;
  title: string | null;
  caption: string | null;
  visibility: string;
  status: string;
  requiresPayment: boolean;
  unlockPriceCredits: number | null;
  publishedAt: string | null;
  createdAt: string | null;
};

function mediaKind(file: File): "image" | "video" | "audio" {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  return "image";
}

const areaClass =
  "min-h-[72px] w-full rounded-xl border border-border bg-surface2 px-3 py-2 text-sm text-white placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/60";

export default function CreatorStudioPage() {
  const router = useRouter();
  const { user, creatorProfile, isCreator, loading, refresh } = useAppSession();
  const [stageName, setStageName] = useState("");
  const [about, setAbout] = useState("");
  const [tags, setTags] = useState("");
  const [price, setPrice] = useState("0");
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [videoCallEnabled, setVideoCallEnabled] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  const [profileErr, setProfileErr] = useState<string | null>(null);

  const [posts, setPosts] = useState<ContentRow[]>([]);
  const [postsErr, setPostsErr] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [visibility, setVisibility] = useState<"subscribers" | "exclusive_ppv" | "followers" | "public">("subscribers");
  const [unlockCredits, setUnlockCredits] = useState("299");
  const [postFile, setPostFile] = useState<File | null>(null);
  const [postBusy, setPostBusy] = useState(false);
  const [postMsg, setPostMsg] = useState<string | null>(null);
  const [postErr, setPostErr] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user && !loadTokens()?.accessToken) {
      router.replace("/login");
    }
  }, [loading, user, router]);

  useEffect(() => {
    if (!creatorProfile) return;
    setStageName(creatorProfile.stageName || "");
    setAbout(creatorProfile.about || "");
    setTags(creatorProfile.categoryTags?.join(", ") || "");
    setPrice(String(creatorProfile.defaultSubscriptionPriceCredits ?? 0));
    setLiveEnabled(Boolean(creatorProfile.liveEnabled));
    setVideoCallEnabled(Boolean(creatorProfile.videoCallEnabled));
  }, [creatorProfile]);

  const loadPosts = useCallback(async () => {
    if (!creatorProfile?.id) return;
    setPostsErr(null);
    try {
      const res = await apiGet<{ content: ContentRow[] }>(`/creators/${creatorProfile.id}/content?limit=50`);
      setPosts(res.content || []);
    } catch (e: any) {
      setPostsErr(e?.body?.error || e?.message || "failed to load posts");
    }
  }, [creatorProfile?.id]);

  useEffect(() => {
    if (isCreator && creatorProfile?.id) loadPosts();
  }, [isCreator, creatorProfile?.id, loadPosts]);

  async function onSaveCreatorProfile(e: React.FormEvent) {
    e.preventDefault();
    setProfileBusy(true);
    setProfileErr(null);
    setProfileMsg(null);
    try {
      const categoryTags = tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      await apiPut("/creators/me", {
        stageName: stageName.trim(),
        about: about.trim(),
        categoryTags,
        defaultSubscriptionPriceCredits: Math.max(0, Number(price) || 0),
        liveEnabled,
        videoCallEnabled
      });
      await refresh();
      setProfileMsg("Creator profile updated.");
    } catch (e: any) {
      setProfileErr(e?.body?.error || e?.message || "save failed");
    } finally {
      setProfileBusy(false);
    }
  }

  async function onPublishContent(e: React.FormEvent) {
    e.preventDefault();
    if (!postFile) {
      setPostErr("Choose a photo or video.");
      return;
    }
    const requiresPayment = visibility === "exclusive_ppv";
    const credits = requiresPayment ? Math.max(1, Number(unlockCredits) || 0) : 0;
    if (requiresPayment && credits <= 0) {
      setPostErr("Set an unlock price for PPV.");
      return;
    }

    setPostBusy(true);
    setPostErr(null);
    setPostMsg(null);
    try {
      const kind = mediaKind(postFile);
      const { id: mediaAssetId } = await uploadUserMedia(postFile, kind);
      await apiPost("/content", {
        title: title.trim() || undefined,
        caption: caption.trim() || undefined,
        visibility,
        status: "published",
        requiresPayment,
        unlockPriceCredits: credits,
        mediaAssetIds: [mediaAssetId]
      });
      setTitle("");
      setCaption("");
      setPostFile(null);
      setPostMsg("Published.");
      await loadPosts();
    } catch (e: any) {
      setPostErr(e?.body?.error || e?.message || "publish failed");
    } finally {
      setPostBusy(false);
    }
  }

  if (loading || (!user && loadTokens()?.accessToken)) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center text-muted">
        <p className="font-bold">Loading studio…</p>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  if (!isCreator || !creatorProfile) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <h1 className="text-2xl font-black text-text">Creator studio</h1>
        <p className="mt-3 text-sm text-muted">This area is for approved creators. Complete creator registration to get a studio profile.</p>
        <Link href="/register/creator" className="mt-6 inline-block rounded-xl bg-accent px-5 py-3 text-sm font-extrabold text-white">
          Apply as creator
        </Link>
        <p className="mt-6">
          <Link href="/me" className="text-sm font-bold text-accent hover:underline">
            Back to profile
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-accent">Creator</p>
          <h1 className="text-2xl font-black text-text">Studio</h1>
          <p className="mt-1 text-sm text-muted">Manage your creator profile and publish exclusive posts.</p>
        </div>
        <Link href="/me" className="text-sm font-extrabold text-muted hover:text-text">
          Fan profile →
        </Link>
      </div>

      <Card>
        <CardHeader>
          <h2 className="m-0 text-sm font-black text-text">Creator profile</h2>
        </CardHeader>
        <CardBody>
          <form onSubmit={onSaveCreatorProfile} className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-bold text-muted">Stage name</label>
              <Input value={stageName} onChange={(e) => setStageName(e.target.value)} required />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-bold text-muted">About</label>
              <textarea value={about} onChange={(e) => setAbout(e.target.value)} className={areaClass} rows={3} />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-bold text-muted">Category tags (comma-separated)</label>
              <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="music, fitness" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-bold text-muted">Default subscription (credits)</label>
              <Input type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} />
            </div>
            <div className="flex flex-col justify-end gap-2">
              <label className="flex items-center gap-2 text-sm font-bold text-text">
                <input type="checkbox" checked={liveEnabled} onChange={(e) => setLiveEnabled(e.target.checked)} />
                Live enabled
              </label>
              <label className="flex items-center gap-2 text-sm font-bold text-text">
                <input type="checkbox" checked={videoCallEnabled} onChange={(e) => setVideoCallEnabled(e.target.checked)} />
                Video calls enabled
              </label>
            </div>
            {profileErr ? <p className="sm:col-span-2 text-sm font-bold text-danger">{profileErr}</p> : null}
            {profileMsg ? <p className="sm:col-span-2 text-sm font-bold text-accent">{profileMsg}</p> : null}
            <div className="sm:col-span-2">
              <Button type="submit" disabled={profileBusy}>
                {profileBusy ? "Saving…" : "Save creator profile"}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="m-0 text-sm font-black text-text">New post</h2>
          <p className="mt-1 text-xs text-muted">Upload media and choose who can see it. PPV uses exclusive visibility.</p>
        </CardHeader>
        <CardBody>
          <form onSubmit={onPublishContent} className="flex flex-col gap-4">
            <div>
              <label className="mb-1 block text-xs font-bold text-muted">Title</label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-bold text-muted">Caption</label>
              <textarea value={caption} onChange={(e) => setCaption(e.target.value)} className={areaClass} rows={2} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-bold text-muted">Visibility</label>
              <select
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as typeof visibility)}
                className="h-10 w-full rounded-xl border border-border bg-surface2 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-accent/60"
              >
                <option value="subscribers">Subscribers only</option>
                <option value="exclusive_ppv">Exclusive PPV (paid unlock)</option>
                <option value="followers">Followers</option>
                <option value="public">Public</option>
              </select>
            </div>
            {visibility === "exclusive_ppv" ? (
              <div>
                <label className="mb-1 block text-xs font-bold text-muted">Unlock price (credits)</label>
                <Input type="number" min={1} value={unlockCredits} onChange={(e) => setUnlockCredits(e.target.value)} />
              </div>
            ) : null}
            <div>
              <label className="mb-1 block text-xs font-bold text-muted">Media file</label>
              <input
                type="file"
                accept="image/*,video/*"
                onChange={(e) => setPostFile(e.target.files?.[0] || null)}
                className="text-sm text-muted file:mr-2 file:rounded-lg file:border-0 file:bg-surface2 file:px-3 file:py-2 file:text-xs file:font-extrabold file:text-text"
              />
            </div>
            {postErr ? <p className="text-sm font-bold text-danger">{postErr}</p> : null}
            {postMsg ? <p className="text-sm font-bold text-accent">{postMsg}</p> : null}
            <Button type="submit" disabled={postBusy}>
              {postBusy ? "Publishing…" : "Publish"}
            </Button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="m-0 text-sm font-black text-text">Your posts</h2>
          <Button type="button" variant="secondary" size="sm" onClick={() => loadPosts()}>
            Refresh
          </Button>
        </CardHeader>
        <CardBody>
          {postsErr ? <p className="text-sm font-bold text-danger">{postsErr}</p> : null}
          {posts.length === 0 && !postsErr ? (
            <p className="text-sm text-muted">No posts yet.</p>
          ) : (
            <ul className="space-y-3">
              {posts.map((p) => (
                <li key={p.id} className="rounded-xl border border-border bg-surface2/50 px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-extrabold text-text">{p.title || "(untitled)"}</span>
                    <span className="text-[10px] font-bold uppercase text-muted">
                      {p.visibility} · {p.status}
                    </span>
                  </div>
                  {p.caption ? <p className="mt-1 text-xs text-muted line-clamp-2">{p.caption}</p> : null}
                  {p.requiresPayment ? (
                    <p className="mt-1 text-xs font-bold text-accent">{p.unlockPriceCredits ?? 0} credits to unlock</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
