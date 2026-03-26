"use client";

import { useEffect } from "react";
import { reportNavigationTiming } from "../lib/analytics";

export default function NavigationAnalytics() {
  useEffect(() => {
    const t = window.setTimeout(() => reportNavigationTiming(), 0);
    return () => clearTimeout(t);
  }, []);
  return null;
}
