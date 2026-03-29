"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAppSession } from "../../context/AppSessionContext";

export default function CallsRequestsPage() {
  const router = useRouter();
  const { isCreator, loading } = useAppSession();

  useEffect(() => {
    if (loading) return;
    router.replace(isCreator ? "/creator" : "/creators");
  }, [isCreator, loading, router]);

  return (
    <div className="py-8">
      <h1>Video calls moved</h1>
      <p className="mt-2 text-muted">Standalone call pages have been removed. Request calls from a creator profile or manage them from creator studio.</p>
      <Link href={isCreator ? "/creator" : "/creators"} className="mt-3 inline-block text-sm text-accent underline">
        Continue
      </Link>
    </div>
  );
}
