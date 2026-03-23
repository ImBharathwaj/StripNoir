# 1. Node.js (API Service)

Use a modular structure aligned with the API design.

## Folder structure

```bash
services/api/
├── src/
│   ├── modules/
│   │   ├── auth/
│   │   ├── user/
│   │   ├── content/
│   │   ├── media/
│   │   ├── chat/          # only token + orchestration
│   │   ├── stream/
│   │   ├── call/
│   │   ├── payment/
│   │   └── notification/
│   │
│   ├── routes/
│   ├── middlewares/
│   ├── config/
│   ├── utils/
│   └── app.js
│
├── package.json
└── Dockerfile
```

---

## App bootstrap

```js
// src/app.js
const express = require('express');
const routes = require('./routes');

const app = express();
app.use(express.json());

app.use('/api/v1', routes);

module.exports = app;
```

---

## Central route loader

```js
// src/routes/index.js
const router = require('express').Router();

router.use('/auth', require('../modules/auth/auth.routes'));
router.use('/users', require('../modules/user/user.routes'));
router.use('/content', require('../modules/content/content.routes'));
router.use('/media', require('../modules/media/media.routes'));
router.use('/chat', require('../modules/chat/chat.routes'));
router.use('/streams', require('../modules/stream/stream.routes'));
router.use('/calls', require('../modules/call/call.routes'));
router.use('/payments', require('../modules/payment/payment.routes'));
router.use('/notifications', require('../modules/notification/notification.routes'));

module.exports = router;
```

---

## Example module (Auth)

### Routes

```js
// modules/auth/auth.routes.js
const router = require('express').Router();
const controller = require('./auth.controller');

router.post('/register', controller.register);
router.post('/login', controller.login);
router.get('/me', controller.me);

module.exports = router;
```

---

### Controller

```js
// modules/auth/auth.controller.js
const service = require('./auth.service');

exports.register = async (req, res) => {
  const user = await service.register(req.body);
  res.json(user);
};

exports.login = async (req, res) => {
  const token = await service.login(req.body);
  res.json({ token });
};

exports.me = async (req, res) => {
  const user = await service.getMe(req.user.id);
  res.json(user);
};
```

---

### Service

```js
// modules/auth/auth.service.js
exports.register = async (data) => {
  // DB logic
  return { id: 1, email: data.email };
};

exports.login = async ({ email, password }) => {
  // validate + generate JWT
  return "jwt_token";
};

exports.getMe = async (userId) => {
  return { id: userId };
};
```

---

## Chat (Node side = only token)

```js
// modules/chat/chat.routes.js
const router = require('express').Router();
const controller = require('./chat.controller');

router.get('/ws-token', controller.getToken);

module.exports = router;
```

```js
// modules/chat/chat.controller.js
exports.getToken = async (req, res) => {
  // generate JWT for Go service
  res.json({ token: "chat_jwt" });
};
```

---

## Stream (LiveKit integration point)

```js
// modules/stream/stream.routes.js
const router = require('express').Router();
const controller = require('./stream.controller');

router.post('/start', controller.startStream);
router.post('/:id/join', controller.joinStream);
router.post('/:id/end', controller.endStream);

module.exports = router;
```

```js
// modules/stream/stream.controller.js
exports.startStream = async (req, res) => {
  // generate LiveKit token
  res.json({
    room: "stream_123",
    token: "livekit_token"
  });
};
```

---

# 2. Go (Chat Service)

Keep this **lean and high-performance**.

---

## Folder structure

```bash
services/chat/
├── cmd/
│   └── main.go
├── internal/
│   ├── ws/
│   ├── handler/
│   ├── service/
│   └── auth/
├── pkg/
├── go.mod
└── Dockerfile
```

---

## Entry point

```go
// cmd/main.go
package main

import (
	"log"
	"net/http"
	"chat/internal/ws"
)

func main() {
	http.HandleFunc("/ws", ws.HandleWebSocket)

	log.Println("Chat service running on :8080")
	http.ListenAndServe(":8080", nil)
}
```

---

## WebSocket handler

```go
// internal/ws/handler.go
package ws

import (
	"net/http"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{}

func HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	go handleConnection(conn)
}

func handleConnection(conn *websocket.Conn) {
	defer conn.Close()

	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			break
		}

		// echo for now
		conn.WriteMessage(websocket.TextMessage, msg)
	}
}
```

---

## Auth (validate token from Node)

```go
// internal/auth/jwt.go
package auth

func ValidateToken(token string) (string, error) {
	// verify JWT from Node
	return "userID", nil
}
```

---

## Chat service logic (expand later)

```go
// internal/service/chat.go
package service

func SendMessage(roomID string, message string) {
	// later:
	// publish to Redis / Kafka
}
```

---

# 3. How they connect

### Flow:

```text
Client → Node API → /chat/ws-token
       → gets token
       → connects → Go WS (/ws?token=...)
```

---

# 4. What to build FIRST (your case)

Don’t try to complete everything.

Start with:

### Node:

* Auth
* User
* Content
* Stream (basic)
* Chat token

### Go:

* WebSocket server
* Token validation
* Basic messaging

---