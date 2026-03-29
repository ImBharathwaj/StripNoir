"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAppSession } from "../../../context/AppSessionContext";

export default function ChatRoomsPage() {
  const router = useRouter();
  const { isCreator, loading } = useAppSession();

  useEffect(() => {
    if (loading) return;
    router.replace(isCreator ? "/creator" : "/creators");
  }, [isCreator, loading, router]);

  return (
    <div className="py-8">
      <h1>Direct chat moved</h1>
      <p className="mt-2 text-muted">Standalone room pages have been removed. Open chat from a creator profile or from creator studio.</p>
      <Link href={isCreator ? "/creator" : "/creators"} className="mt-3 inline-block text-sm text-accent underline">
        Continue
      </Link>
    </div>
  );
}
