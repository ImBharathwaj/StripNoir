# 0. Base conventions

* Base URL: `/api/v1`
* Auth: JWT (Bearer)
* Roles: `user | creator | admin`

---

# 1. Auth Module

```http
POST   /auth/register
POST   /auth/login
POST   /auth/logout
POST   /auth/refresh
GET    /auth/me
```

---

# 2. User Module

```http
GET    /users/:id
PUT    /users/me
GET    /users/:id/followers
POST   /users/:id/follow
DELETE /users/:id/unfollow
```

---

# 3. Creator Module

```http
POST   /creators/apply
GET    /creators/:id
PUT    /creators/me

POST   /creators/subscription
GET    /creators/:id/subscription
DELETE /creators/:id/subscription
```

---

# 4. Content Module (Posts / Media)

```http
POST   /content/upload-url        # pre-signed upload
POST   /content                  # create post
GET    /content/:id
DELETE /content/:id

GET    /feed                     # personalized feed
GET    /creators/:id/content
```

---

# 5. Media Module

```http
POST   /media/upload-url
POST   /media/complete
GET    /media/:id
```

---

# 6. Chat Module (Go service will back this)

```http
POST   /chat/rooms               # create room
GET    /chat/rooms/:id
GET    /chat/rooms

POST   /chat/rooms/:id/message   # fallback (REST)
GET    /chat/rooms/:id/messages

GET    /chat/ws-token            # WebSocket auth token
```

WebSocket (handled by Go):

```
/ws?token=...
```

---

# 7. Live Stream Module

```http
POST   /streams/start            # creator starts stream
POST   /streams/:id/join         # viewer joins
POST   /streams/:id/end

GET    /streams/live             # list live streams
GET    /streams/:id
```

Response includes:

* LiveKit room
* Token

---

# 8. Private Call Module (1:1 video)

```http
POST   /calls/create
POST   /calls/:id/join
POST   /calls/:id/end

GET    /calls/:id
```

Optional:

```http
POST   /calls/:id/accept
POST   /calls/:id/reject
```

---

# 9. Payment Module

```http
POST   /payments/deposit
POST   /payments/subscribe
POST   /payments/tip

GET    /payments/history
GET    /wallet/balance
```

Creator side:

```http
POST   /payouts/request
GET    /payouts/history
```

---

# 10. Notification Module

```http
GET    /notifications
POST   /notifications/read
```

---

# 11. Feed Module

```http
GET    /feed
GET    /feed/trending
GET    /feed/following
```

---

# 12. Admin Module (minimal)

```http
GET    /admin/users
GET    /admin/creators
POST   /admin/ban-user
```

---

# 13. Internal (service-to-service)

Not public, but important:

```http
POST   /internal/chat/publish
POST   /internal/notifications/send
POST   /internal/streams/update
```

---

# 14. Key response examples

### Stream Join

```json
{
  "streamId": "abc123",
  "room": "stream_abc123",
  "token": "livekit_jwt",
  "wsChatUrl": "wss://chat.yourapp/ws"
}
```

---

### Chat WS Token

```json
{
  "token": "chat_jwt",
  "roomId": "abc123"
}
```

---

# 15. Module ownership (important)

* Node (API):

  * Auth, Users, Payments, Content, Streams

* Go (Chat):

  * WebSockets
  * Messaging

* LiveKit:

  * Video/Audio

---

# 16. Minimal MVP subset (build this first)

Don’t build everything at once.

Start with:

* Auth
* User
* Content
* Chat (basic)
* Stream (start/join)
* Payment (basic credits)

---