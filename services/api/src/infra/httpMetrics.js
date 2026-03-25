/**
 * Lightweight Prometheus-style metrics for HTTP (no extra npm deps).
 * Used to validate Phase 4 exit criteria: observe poll-fallback route volume and latency buckets.
 */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;

const DURATION_BUCKETS_MS = [5, 25, 50, 100, 250, 500, 1000, 2500, 5000];

function normalizeApiPath(path) {
  if (!path || typeof path !== 'string') {
    return '';
  }
  return path.replace(UUID_RE, ':id');
}

/**
 * Low-cardinality groups for Prometheus labels (avoid per-UUID series).
 */
function metricsRouteGroup(method, rawPath) {
  const p = normalizeApiPath(rawPath);
  if (method === 'GET' && /^\/api\/v1\/chat\/rooms\/:id\/messages$/i.test(p)) {
    return 'poll_fallback_chat_messages';
  }
  if (method === 'GET' && p === '/api/v1/notifications') {
    return 'poll_fallback_notifications_list';
  }
  if (method === 'GET' && /^\/api\/v1\/calls\/:id$/i.test(p)) {
    return 'poll_fallback_call_detail';
  }
  if (method === 'GET' && /^\/api\/v1\/streams\/:id$/i.test(p)) {
    return 'poll_fallback_stream_detail';
  }
  if (method === 'GET' && p === '/api/v1/streams/live') {
    return 'poll_fallback_streams_live';
  }
  if (method === 'GET' && /^\/api\/v1\/calls\/requests\//i.test(p)) {
    return 'call_requests_list';
  }
  if (p === '/health' || p === '/health/deps') {
    return 'health';
  }
  if (method === 'GET' && p.startsWith('/api/v1/')) {
    return 'api_v1_get_other';
  }
  if (p.startsWith('/api/v1/')) {
    return 'api_v1_mutations';
  }
  return 'other';
}

function isPollFallbackGroup(group) {
  return typeof group === 'string' && group.startsWith('poll_fallback_');
}

function createEmptyHistogram() {
  const buckets = {};
  for (const b of DURATION_BUCKETS_MS) {
    buckets[b] = 0;
  }
  buckets.Inf = 0;
  return { count: 0, sumMs: 0, buckets };
}

function observeHistogram(hist, ms) {
  hist.count += 1;
  hist.sumMs += ms;
  let placed = false;
  for (const b of DURATION_BUCKETS_MS) {
    if (ms <= b) {
      hist.buckets[b] += 1;
      placed = true;
      break;
    }
  }
  if (!placed) {
    hist.buckets.Inf += 1;
  }
}

class HttpMetrics {
  constructor() {
    this.startedAtMs = Date.now();
    /** @type {Map<string, { requests: number, errors: number, hist: ReturnType<createEmptyHistogram> }>} */
    this.byGroup = new Map();
  }

  ensure(group) {
    if (!this.byGroup.has(group)) {
      this.byGroup.set(group, { requests: 0, errors: 0, hist: createEmptyHistogram() });
    }
    return this.byGroup.get(group);
  }

  record(method, path, statusCode, durationMs) {
    const group = metricsRouteGroup(method, path);
    const row = this.ensure(group);
    row.requests += 1;
    if (Number(statusCode) >= 500) {
      row.errors += 1;
    }
    observeHistogram(row.hist, Math.max(0, durationMs));
  }

  prometheusText() {
    const lines = [];
    const uptimeSec = Math.floor((Date.now() - this.startedAtMs) / 1000);
    lines.push('# HELP stripnoir_api_process_uptime_seconds Uptime of the API process');
    lines.push('# TYPE stripnoir_api_process_uptime_seconds gauge');
    lines.push(`stripnoir_api_process_uptime_seconds ${uptimeSec}`);
    lines.push('');
    lines.push('# HELP stripnoir_api_http_requests_total Total API HTTP requests by route group');
    lines.push('# TYPE stripnoir_api_http_requests_total counter');
    lines.push('# HELP stripnoir_api_http_errors_total HTTP 5xx responses by route group');
    lines.push('# TYPE stripnoir_api_http_errors_total counter');

    const sortedGroups = [...this.byGroup.keys()].sort();
    for (const g of sortedGroups) {
      const row = this.byGroup.get(g);
      const safe = JSON.stringify(g);
      lines.push(`stripnoir_api_http_requests_total{route_group=${safe}} ${row.requests}`);
      lines.push(`stripnoir_api_http_errors_total{route_group=${safe}} ${row.errors}`);
    }

    lines.push('');
    lines.push('# HELP stripnoir_api_http_request_duration_ms Histogram of request duration (ms) by route group');
    lines.push('# TYPE stripnoir_api_http_request_duration_ms histogram');

    for (const g of sortedGroups) {
      const row = this.byGroup.get(g);
      const safe = JSON.stringify(g);
      const { hist } = row;
      let cumulative = 0;
      for (const b of DURATION_BUCKETS_MS) {
        cumulative += hist.buckets[b];
        lines.push(
          `stripnoir_api_http_request_duration_ms_bucket{route_group=${safe},le="${b}"} ${cumulative}`
        );
      }
      cumulative += hist.buckets.Inf;
      lines.push(`stripnoir_api_http_request_duration_ms_bucket{route_group=${safe},le="+Inf"} ${cumulative}`);
      lines.push(`stripnoir_api_http_request_duration_ms_sum{route_group=${safe}} ${hist.sumMs}`);
      lines.push(`stripnoir_api_http_request_duration_ms_count{route_group=${safe}} ${hist.count}`);
    }

    lines.push('');
    return `${lines.join('\n')}\n`;
  }

  jsonSummary() {
    const groups = {};
    for (const [g, row] of this.byGroup) {
      groups[g] = {
        requests: row.requests,
        errors: row.errors,
        durationMs: {
          count: row.hist.count,
          sum: row.hist.sumMs,
          buckets: { ...row.hist.buckets }
        }
      };
    }
    return {
      uptimeSeconds: Math.floor((Date.now() - this.startedAtMs) / 1000),
      routeGroups: groups,
      note: 'Use histogram buckets with Prometheus or histogram_quantile for p95; poll_fallback_* groups are REST polling fallbacks.'
    };
  }
}

const singleton = new HttpMetrics();

function metricsEnabled() {
  const v = process.env.METRICS_ENABLED;
  if (v === undefined || v === '') {
    return false;
  }
  return String(v).toLowerCase() === '1' || String(v).toLowerCase() === 'true';
}

/** Full path without query (works for top-level app and mounted routers). */
function requestFullPath(req) {
  const u = req.originalUrl || req.url || '';
  const q = u.indexOf('?');
  return q >= 0 ? u.slice(0, q) : u;
}

function createMetricsMiddleware(metrics = singleton) {
  return function metricsMiddleware(req, res, next) {
    if (!metricsEnabled()) {
      return next();
    }
    const path = requestFullPath(req);
    if (path === '/metrics' || path === '/metrics.json') {
      return next();
    }
    const start = Date.now();
    res.on('finish', () => {
      try {
        metrics.record(req.method, path, res.statusCode, Date.now() - start);
      } catch {
        /* ignore */
      }
    });
    next();
  };
}

/** Sets a response header so clients treat REST as fallback vs Go WS / long-poll. */
function pollFallbackHintMiddleware(req, res, next) {
  const path = requestFullPath(req);
  const group = metricsRouteGroup(req.method, path);
  if (isPollFallbackGroup(group)) {
    res.setHeader('X-StripNoir-Realtime', 'prefer-go-websocket-or-long-poll');
  }
  next();
}

module.exports = {
  HttpMetrics,
  metricsRouteGroup,
  normalizeApiPath,
  isPollFallbackGroup,
  createMetricsMiddleware,
  pollFallbackHintMiddleware,
  metricsEnabled,
  metricsSingleton: singleton
};
