# Kubernetes samples (Phase 5 scaffold)

These manifests are **starting points**, not a production chart. Adjust images, secrets, ingress, and resource limits for your cluster.

## Contents

| File | Purpose |
|------|---------|
| `namespace.yaml` | `stripnoir` namespace |
| `api-deployment.yaml` | Node API Deployment + Service (ClusterIP) |
| `chat-deployment.yaml` | Go chat Deployment + Service |
| `worker-deployment.yaml` | Placeholder worker Deployment (Redis queue consumer) |
| `hpa-api.yaml` | HorizontalPodAutoscaler for API (CPU 70%) |
| `hpa-chat.yaml` | HPA for Go realtime (CPU 60%) |

## Autoscaling groups

Run **separate Deployments** for Node API, Go chat, and workers — each with its own HPA and PDB (add later). Chat pods must scale with Redis pub/sub (already supported).

## Canary

Use a second Deployment (e.g. `api-canary`) + Service or Istio/Linkerd traffic split. The nginx gateway template in `infra/nginx/gateway.conf` includes commented `upstream` stubs for a canary upstream.

## Apply

```bash
kubectl apply -f infra/k8s/namespace.yaml
kubectl apply -f infra/k8s/api-deployment.yaml
kubectl apply -f infra/k8s/chat-deployment.yaml
kubectl apply -f infra/k8s/worker-deployment.yaml
kubectl apply -f infra/k8s/hpa-api.yaml
kubectl apply -f infra/k8s/hpa-chat.yaml
```

Set `image:` to your registry builds and inject `Secret`/`ConfigMap` for `DATABASE_URL`, `REDIS_URL`, `JWT_*`, `CHAT_INTERNAL_API_KEY`, etc.

## Metrics-server

HPA CPU utilization requires [metrics-server](https://github.com/kubernetes-sigs/metrics-server) installed on the cluster.

## Phase 7 (multi-region)

Per-region Deployments reuse these manifests with different `ConfigMap` / `Secret` values (`DATABASE_READ_URL`, regional `REDIS_URL`, and `CHAT_PUBLIC_URL` for clients). See `docs/operations/Phase7_Multi_Region_and_Reliability.md`.
