## 1) Core principle

Treat each language as a **separate service**, not a mixed codebase.

> One service = one language = one deployable unit

So:

* Node = API / business logic
* Go = chat / high-concurrency service

They communicate over network (HTTP/gRPC), not by sharing code.

---

## 2) Folder structure (production-friendly)

Keep a **mono-repo with multiple services**:

```id="hybrid-structure"
project-root/
│
├── services/
│   ├── api/              # Node.js (main backend)
│   │   ├── src/
│   │   ├── package.json
│   │   └── Dockerfile
│   │
│   ├── chat/             # Go (WebSocket service)
│   │   ├── cmd/
│   │   ├── internal/
│   │   ├── go.mod
│   │   └── Dockerfile
│
├── infra/
│   ├── docker-compose.yml
│   ├── nginx/
│   └── k8s/              # later (Kubernetes manifests)
│
├── shared-contracts/     # API schemas (important)
│   ├── openapi.yaml
│   └── protobuf/         # if using gRPC later
│
└── README.md
```

---

## 3) How services communicate

Start simple:

### Option A (recommended early)

* HTTP REST between Node ↔ Go

Example:

```id="comm1"
Node API → calls → Go Chat Service (http://chat:8080)
```

---

### Option B (later, better)

* gRPC (faster, typed contracts)

---

### Option C (for scale)

* Event-driven:

  * Redis Pub/Sub
  * Kafka

---

## 4) Local development setup

Use **Docker Compose** first (don’t jump to Kubernetes yet).

Example:

```yaml
# infra/docker-compose.yml
version: '3.8'

services:
  api:
    build: ../services/api
    ports:
      - "3000:3000"
    depends_on:
      - redis

  chat:
    build: ../services/chat
    ports:
      - "8080:8080"
    depends_on:
      - redis

  redis:
    image: redis:7
    ports:
      - "6379:6379"
```

Now you run everything with:

```bash
docker-compose up
```

---

## 5) Deployment strategy (simple → advanced)

### Stage 1 (NOW)

* Single VPS (Hetzner etc.)
* Docker Compose
* Nginx as reverse proxy

Flow:

```id="deploy1"
Internet → Nginx → API (Node)
                    → Chat (Go)
```

---

### Stage 2 (growth)

Move to:

* Kubernetes

Each service:

* Separate deployment
* Independent scaling

---

## 6) Routing example

Nginx:

```nginx
location /api/ {
    proxy_pass http://api:3000;
}

location /ws/ {
    proxy_pass http://chat:8080;
}
```

---

## 7) Shared contracts (VERY important)

Avoid breaking communication between Node and Go.

Use:

* OpenAPI (for REST)
* Protobuf (for gRPC later)

Store in:

```id="contracts"
shared-contracts/
```

---

## 8) Dev workflow

* You work mostly in Node (fast iteration)
* Only touch Go when needed (chat scaling)

Run:

```bash
docker-compose up
```

Test both services together.

---

## 9) Common mistakes to avoid

* Mixing Node & Go in same service ❌
* Calling DB directly from both services randomly ❌
* No contract definition ❌
* Jumping to Kubernetes too early ❌

---

## 10) What this gives you

* Clean separation
* Easy scaling later
* No rewrite when you extract services
* Team-friendly structure

---

## Simple mental model

You are not building:

> “one hybrid app”

You are building:

> **multiple small services written in different languages**

---

## Final takeaway

Start like this:

* Node = main brain
* Go = high-performance muscle
* Docker = glue
* Contracts = discipline
