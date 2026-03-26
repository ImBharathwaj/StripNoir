/**
 * Frontend-only funnel + perf instrumentation (console for now; swap for analytics SDK later).
 */

export function trackEvent(name: string, payload?: Record<string, unknown>) {
  if (typeof window === 'undefined') return;
  if (payload && Object.keys(payload).length > 0) {
    console.info(`[StripNoir] ${name}`, payload);
  } else {
    console.info(`[StripNoir] ${name}`);
  }
}

export function trackWsConnectMs(channel: string, ms: number) {
  trackEvent('ws_connect_ms', { channel, ms: Math.round(ms) });
}

export function reportNavigationTiming() {
  if (typeof window === 'undefined') return;
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (nav && nav.loadEventEnd > 0) {
      trackEvent('perf_navigation', {
        domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
        loadCompleteMs: Math.round(nav.loadEventEnd - nav.startTime),
        navType: nav.type
      });
    }
  } catch {
    // ignore
  }
}
