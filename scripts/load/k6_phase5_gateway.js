/**
 * Phase 5 staging benchmark: HTTP load through the nginx gateway (API + chat health).
 *
 * Not run in CI. Install k6 (https://k6.io/) and run from repo root:
 *
 *   GATEWAY_BASE_URL=http://localhost:14000 TARGET_VUS=500 HOLD_DURATION=3m \
 *     k6 run scripts/load/k6_phase5_gateway.js
 *
 * For targets toward ~50k concurrent VUs, use a distributed k6 run (k6 cloud or
 * multiple instances); a single process/machine typically caps out well below 50k.
 */
import http from 'k6/http';
import { check } from 'k6';

const gateway = __ENV.GATEWAY_BASE_URL || 'http://localhost:14000';
const target = Math.max(1, Number(__ENV.TARGET_VUS || 100));
const hold = __ENV.HOLD_DURATION || '2m';
const ramp = __ENV.RAMP_DURATION || '1m';

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
      gracefulRampDown: '30s'
    }
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<5000']
  }
};

export default function () {
  const api = http.get(`${gateway}/health`);
  check(api, { 'api health 2xx': (r) => r.status >= 200 && r.status < 300 });

  const chat = http.get(`${gateway}/chat/health`);
  check(chat, { 'chat health 2xx': (r) => r.status >= 200 && r.status < 300 });
}
