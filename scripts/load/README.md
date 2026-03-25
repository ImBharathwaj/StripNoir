# Load and concurrency scripts

| Script | Purpose |
|--------|---------|
| `smoke_realtime_concurrency.sh` | Phase 4: parallel bash workers hit API + chat `/health` (no `/api/v1` rate limits). Safe for local smoke. |
| `k6_phase5_gateway.js` | Phase 5: k6 ramp against **gateway** `/health` and `/chat/health`. Use in staging when sizing toward high concurrency (see `docs/operations/Phase5_Scaling_Guide.md` §8). |
| `k6_phase7_high_concurrency.js` | Phase 7: same pattern with longer defaults / rehearsal notes for **distributed** high-VU runs (`docs/operations/Phase7_Multi_Region_and_Reliability.md` §5). |

**k6:** install from [k6.io](https://k6.io/docs/get-started/installation/). Very high VU targets require distributed execution (k6 cloud or multiple runners), not a single laptop.

**Multi-edge smoke:** `scripts/verify_multi_region_smoke.sh` — `SINGLE_GATEWAY` and/or `GATEWAY_A` / `GATEWAY_B`.
