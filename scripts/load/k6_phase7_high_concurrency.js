/**
 * Phase 7: high-concurrency rehearsal template (e.g. 200k+ VUs with distributed k6).
 *
 * Same traffic pattern as Phase 5 gateway mix; defaults expect you to scale out runners.
 *
 *   GATEWAY_BASE_URL=https://edge.example TARGET_VUS=200000 HOLD_DURATION=10m \
 *     k6 run scripts/load/k6_phase7_high_concurrency.js
 *
 * Single-machine k6 caps well below 200k; use k6 cloud or sharded execution per k6 docs.
 */
import http from 'k6/http';
import { check } from 'k6';

const gateway = __ENV.GATEWAY_BASE_URL || 'http://localhost:14000';
const target = Math.max(1, Number(__ENV.TARGET_VUS || 500));
const hold = __ENV.HOLD_DURATION || '3m';
const ramp = __ENV.RAMP_DURATION || '2m';

export const options = {
  scenarios: {
    gateway_mixed_health: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: ramp, target },
        { duration: hold, target },
        { duration: ramp, target: 0 }
      ],
      gracefulRampDown: '60s'
    }
  },
  // Tune in staging; very large TARGET_VUS usually needs relaxed thresholds or distributed runners.
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<8000']
  }
};

export default function () {
  const api = http.get(`${gateway}/health`);
  check(api, { 'api health 2xx': (r) => r.status >= 200 && r.status < 300 });

  const chat = http.get(`${gateway}/chat/health`);
  check(chat, { 'chat health 2xx': (r) => r.status >= 200 && r.status < 300 });
}
