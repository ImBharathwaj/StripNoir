"use client";

import type { ReactNode } from "react";
import { AppSessionProvider } from "../context/AppSessionContext";
import NetworkBanner from "./NetworkBanner";
import NavigationAnalytics from "./NavigationAnalytics";
import SkipToMain from "./SkipToMain";
import TopNav from "./TopNav";

export default function ClientShell({ children }: { children: ReactNode }) {
  return (
    <AppSessionProvider>
      <SkipToMain />
      <NetworkBanner />
      <NavigationAnalytics />
      <TopNav />
      <main id="main-content" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-6 outline-none">
        {children}
      </main>
    </AppSessionProvider>
  );
}
