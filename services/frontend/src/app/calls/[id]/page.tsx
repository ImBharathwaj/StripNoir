"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import VideoCallSessionPanel from "../../../components/social/VideoCallSessionPanel";

export default function CallDetailPage() {
  const params = useParams();
  const id = String((params as any).id || "");

  return (
    <div className="py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="m-0">1:1 video call</h1>
        <Link href="/creators" className="text-sm text-accent underline">
          Browse creators
        </Link>
      </div>
      <div className="mt-4">
        <VideoCallSessionPanel callId={id} title="Legacy 1:1 call route" />
      </div>
    </div>
  );
}
