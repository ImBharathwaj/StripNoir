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
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto w-full max-w-[min(100%,88rem)] px-4 py-5 outline-none sm:px-6 lg:px-8"
      >
        {children}
      </main>
    </AppSessionProvider>
  );
}
