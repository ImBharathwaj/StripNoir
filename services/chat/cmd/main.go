package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

type healthResponse struct {
	Service string `json:"service"`
	Status  string `json:"status"`
	Port    string `json:"port"`
}

type dependencyState struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

type depsHealthResponse struct {
	Service      string                     `json:"service"`
	Status       string                     `json:"status"`
	Dependencies map[string]dependencyState `json:"dependencies"`
}

type publishRequest struct {
	RoomID    string          `json:"roomId"`
	EventType string          `json:"eventType"`
	Payload   json.RawMessage `json:"payload"`
}

type chatEvent struct {
	RoomID    string          `json:"roomId,omitempty"`
	UserID    string          `json:"userId,omitempty"`
	EventType string          `json:"eventType"`
	Payload   json.RawMessage `json:"payload"`
	SentAt    time.Time       `json:"sentAt"`
}

type realtimeTokenClaims struct {
	RoomID string `json:"roomId,omitempty"`
	Typ    string `json:"typ"`
	jwt.RegisteredClaims
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func redisChannelForRoom(roomID string) string {
	return "room:" + roomID
}

func redisChannelForUserNotify(userID string) string {
	return "user_notify:" + userID
}

func redisWSPresenceSetKey(roomID string) string {
	return "presence:ws:" + roomID
}

func newConnID() string {
	buf := make([]byte, 16)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

func publishPresenceEvent(ctx context.Context, redisClient *redis.Client, roomID string) error {
	n, err := redisClient.SCard(ctx, redisWSPresenceSetKey(roomID)).Result()
	if err != nil {
		return err
	}
	payload, err := json.Marshal(map[string]any{
		"roomId":         roomID,
		"wsViewerCount":  n,
		"presenceSource": "chat_ws",
	})
	if err != nil {
		return err
	}
	event := chatEvent{
		RoomID:    roomID,
		EventType: "live.ws_presence",
		Payload:   json.RawMessage(payload),
		SentAt:    time.Now().UTC(),
	}
	raw, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return redisClient.Publish(ctx, redisChannelForRoom(roomID), raw).Err()
}

func healthHandler(port string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, healthResponse{
			Service: "chat",
			Status:  "ok",
			Port:    port,
		})
	}
}

func checkPostgres(ctx context.Context, databaseURL string) dependencyState {
	if databaseURL == "" {
		return dependencyState{OK: false, Error: "DATABASE_URL is not set"}
	}

	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return dependencyState{OK: false, Error: err.Error()}
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		return dependencyState{OK: false, Error: err.Error()}
	}

	return dependencyState{OK: true}
}

func checkRedis(ctx context.Context, client *redis.Client) dependencyState {
	if err := client.Ping(ctx).Err(); err != nil {
		return dependencyState{OK: false, Error: err.Error()}
	}
	return dependencyState{OK: true}
}

func depsHealthHandler(databaseURL string, redisClient *redis.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()

		postgresState := checkPostgres(ctx, databaseURL)
		redisState := checkRedis(ctx, redisClient)
		allHealthy := postgresState.OK && redisState.OK

		statusCode := http.StatusOK
		statusText := "ok"
		if !allHealthy {
			statusCode = http.StatusServiceUnavailable
			statusText = "degraded"
		}

		writeJSON(w, statusCode, depsHealthResponse{
			Service: "chat",
			Status:  statusText,
			Dependencies: map[string]dependencyState{
				"postgres": postgresState,
				"redis":    redisState,
			},
		})
	}
}

func extractBearerToken(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(strings.ToLower(auth), "bearer ") {
		return strings.TrimSpace(auth[7:])
	}
	return ""
}

func parseRealtimeToken(tokenString string, jwtSecrets []string, roomIDFromQuery string) (*realtimeTokenClaims, error) {
	if tokenString == "" {
		return nil, errors.New("token is required")
	}

	var lastErr error
	for _, secret := range jwtSecrets {
		if strings.TrimSpace(secret) == "" {
			continue
		}

		claims := &realtimeTokenClaims{}
		token, err := jwt.ParseWithClaims(tokenString, claims, func(token *jwt.Token) (any, error) {
			if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
			}
			return []byte(secret), nil
		})
		if err != nil || !token.Valid {
			lastErr = err
			continue
		}

		switch strings.TrimSpace(claims.Typ) {
		case "chat":
			if claims.Subject == "" {
				return nil, errors.New("token subject missing")
			}
			if strings.TrimSpace(claims.RoomID) == "" {
				return nil, errors.New("token roomId missing")
			}
			if roomIDFromQuery != "" && claims.RoomID != roomIDFromQuery {
				return nil, errors.New("token room mismatch")
			}
			return claims, nil
		case "notify":
			if claims.Subject == "" {
				return nil, errors.New("token subject missing")
			}
			return claims, nil
		default:
			return nil, errors.New("invalid token type")
		}
	}

	if lastErr != nil {
		return nil, errors.New("invalid token")
	}
	return nil, errors.New("no jwt secret configured")
}

func publishHandler(redisClient *redis.Client, internalKey string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}

		if internalKey != "" && r.Header.Get("x-internal-key") != internalKey {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized internal publish"})
			return
		}

		var req publishRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
			return
		}
		if strings.TrimSpace(req.RoomID) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "roomId is required"})
			return
		}
		if strings.TrimSpace(req.EventType) == "" {
			req.EventType = "message.created"
		}
		if len(req.Payload) == 0 {
			req.Payload = json.RawMessage(`{}`)
		}

		event := chatEvent{
			RoomID:    req.RoomID,
			EventType: req.EventType,
			Payload:   req.Payload,
			SentAt:    time.Now().UTC(),
		}
		raw, err := json.Marshal(event)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to marshal event"})
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		if err := redisClient.Publish(ctx, redisChannelForRoom(req.RoomID), raw).Err(); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to publish event"})
			return
		}

		writeJSON(w, http.StatusAccepted, map[string]string{
			"status": "published",
		})
	}
}

type notifyPublishRequest struct {
	UserID    string          `json:"userId"`
	EventType string          `json:"eventType"`
	Payload   json.RawMessage `json:"payload"`
}

func notifyPublishHandler(redisClient *redis.Client, internalKey string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}

		if internalKey != "" && r.Header.Get("x-internal-key") != internalKey {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized internal publish"})
			return
		}

		var req notifyPublishRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
			return
		}
		if strings.TrimSpace(req.UserID) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "userId is required"})
			return
		}
		if strings.TrimSpace(req.EventType) == "" {
			req.EventType = "notification.created"
		}
		if len(req.Payload) == 0 {
			req.Payload = json.RawMessage(`{}`)
		}

		event := chatEvent{
			UserID:    req.UserID,
			EventType: req.EventType,
			Payload:   req.Payload,
			SentAt:    time.Now().UTC(),
		}
		raw, err := json.Marshal(event)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to marshal event"})
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		if err := redisClient.Publish(ctx, redisChannelForUserNotify(req.UserID), raw).Err(); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to publish event"})
			return
		}

		writeJSON(w, http.StatusAccepted, map[string]string{
			"status": "published",
		})
	}
}

func wsHandler(redisClient *redis.Client, jwtSecrets []string, dbPool *pgxpool.Pool) http.HandlerFunc {
	upgrader := websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 1024,
		CheckOrigin: func(r *http.Request) bool {
			return true
		},
	}

	return func(w http.ResponseWriter, r *http.Request) {
		token := r.URL.Query().Get("token")
		requestedRoomID := strings.TrimSpace(r.URL.Query().Get("roomId"))

		claims, err := parseRealtimeToken(token, jwtSecrets, requestedRoomID)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
			return
		}

		if strings.TrimSpace(claims.Typ) == "notify" {
			runNotifyWebSocket(w, r, redisClient, &upgrader, claims.Subject)
			return
		}

		roomID := claims.RoomID
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()

		connID := newConnID()
		presenceKey := redisWSPresenceSetKey(roomID)

		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		sub := redisClient.Subscribe(ctx, redisChannelForRoom(roomID))
		defer sub.Close()
		pubCh := sub.Channel()

		regCtx, regCancel := context.WithTimeout(context.Background(), 3*time.Second)
		if err := redisClient.SAdd(regCtx, presenceKey, connID).Err(); err == nil {
			_ = redisClient.Expire(regCtx, presenceKey, 2*time.Hour).Err()
			if err := publishPresenceEvent(regCtx, redisClient, roomID); err != nil {
				log.Printf("presence publish (join): %v", err)
			}
		} else {
			log.Printf("presence sadd: %v", err)
		}
		regCancel()

		defer func() {
			cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cleanupCancel()
			if err := redisClient.SRem(cleanupCtx, presenceKey, connID).Err(); err != nil {
				log.Printf("presence srem: %v", err)
				return
			}
			if err := publishPresenceEvent(cleanupCtx, redisClient, roomID); err != nil {
				log.Printf("presence publish (leave): %v", err)
			}
		}()

		done := make(chan struct{})
		go func() {
			defer close(done)
			viewerUserID := claims.Subject
			blockCache := map[string]bool{}
			moderationCache := map[string]bool{}

			for msg := range pubCh {
				deliver := true
				if dbPool != nil && strings.HasPrefix(strings.TrimSpace(msg.Payload), "{") {
					// Best-effort filtering:
					// - blocking: suppress room events from a blocked sender
					// - moderation: suppress messages hidden by moderation actions
					var ce chatEvent
					if err := json.Unmarshal([]byte(msg.Payload), &ce); err == nil && strings.HasPrefix(ce.EventType, "message.") {
						var mp struct {
							Message struct {
								ID            string `json:"id"`
								SenderUserID string `json:"sender_user_id"`
							} `json:"message"`
						}
						if err := json.Unmarshal(ce.Payload, &mp); err == nil && strings.TrimSpace(mp.Message.ID) != "" {
							messageID := strings.TrimSpace(mp.Message.ID)

							// 1) Moderation: hide/remove content
							if v, ok := moderationCache[messageID]; ok && v {
								deliver = false
							} else if v, ok := moderationCache[messageID]; ok && !v {
								// already known as visible
							} else {
								queryCtx, queryCancel := context.WithTimeout(context.Background(), 1*time.Second)
								var hidden bool
								err2 := dbPool.QueryRow(queryCtx, `
									SELECT EXISTS(
										SELECT 1
										FROM moderation_report mr
										INNER JOIN moderation_action ma ON ma.report_id = mr.id
										WHERE mr.target_type = 'message'
										  AND mr.target_id = $1::uuid
										  AND ma.action_type IN ('hide_content', 'remove_content')
										  AND (ma.expires_at IS NULL OR ma.expires_at > now())
										LIMIT 1
									)`, messageID).Scan(&hidden)
								queryCancel()
								if err2 == nil {
									moderationCache[messageID] = hidden
									if hidden {
										deliver = false
									}
								}
							}

							// 2) Blocking: suppress events from blocked sender
							if deliver && strings.TrimSpace(mp.Message.SenderUserID) != "" {
								senderID := strings.TrimSpace(mp.Message.SenderUserID)
								cacheKey := viewerUserID + "|" + senderID
								if v, ok := blockCache[cacheKey]; ok && v {
									deliver = false
								} else if v, ok := blockCache[cacheKey]; ok && !v {
									// cached visible
								} else {
									queryCtx, queryCancel := context.WithTimeout(context.Background(), 1*time.Second)
									var blocked bool
									err2 := dbPool.QueryRow(queryCtx, `
										SELECT EXISTS(
											SELECT 1
											FROM user_block
											WHERE (blocker_user_id = $1::uuid AND blocked_user_id = $2::uuid)
											   OR (blocker_user_id = $2::uuid AND blocked_user_id = $1::uuid)
											LIMIT 1
										)`, viewerUserID, senderID).Scan(&blocked)
									queryCancel()
									if err2 == nil {
										blockCache[cacheKey] = blocked
										if blocked {
											deliver = false
										}
									}
								}
							}
						}
					}
				}

				if !deliver {
					continue
				}

				if err := conn.WriteMessage(websocket.TextMessage, []byte(msg.Payload)); err != nil {
					return
				}
			}
		}()

		for {
			_, _, err := conn.ReadMessage()
			if err != nil {
				cancel()
				<-done
				return
			}
		}
	}
}

func runNotifyWebSocket(w http.ResponseWriter, r *http.Request, redisClient *redis.Client, upgrader *websocket.Upgrader, userID string) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sub := redisClient.Subscribe(ctx, redisChannelForUserNotify(userID))
	defer sub.Close()
	pubCh := sub.Channel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		for msg := range pubCh {
			if err := conn.WriteMessage(websocket.TextMessage, []byte(msg.Payload)); err != nil {
				return
			}
		}
	}()

	for {
		_, _, err := conn.ReadMessage()
		if err != nil {
			cancel()
			<-done
			return
		}
	}
}

func longPollEventsHandler(redisClient *redis.Client, jwtSecrets []string, dbPool *pgxpool.Pool) http.HandlerFunc {
	const prefix = "/realtime/rooms/"

	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}

		path := strings.TrimPrefix(r.URL.Path, prefix)
		parts := strings.Split(strings.Trim(path, "/"), "/")
		if len(parts) != 2 || parts[1] != "events" || strings.TrimSpace(parts[0]) == "" {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "invalid events path"})
			return
		}
		roomID := parts[0]

		token := r.URL.Query().Get("token")
		if token == "" {
			token = extractBearerToken(r)
		}
		claims, err := parseRealtimeToken(token, jwtSecrets, roomID)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
			return
		}
		viewerUserID := claims.Subject

		timeoutSec := 25
		if rawTimeout := r.URL.Query().Get("timeoutSec"); rawTimeout != "" {
			if n, err := strconv.Atoi(rawTimeout); err == nil {
				if n < 1 {
					n = 1
				}
				if n > 55 {
					n = 55
				}
				timeoutSec = n
			}
		}

		ctx, cancel := context.WithTimeout(r.Context(), time.Duration(timeoutSec)*time.Second)
		defer cancel()

		sub := redisClient.Subscribe(ctx, redisChannelForRoom(roomID))
		defer sub.Close()
		pubCh := sub.Channel()

		select {
		case <-ctx.Done():
			writeJSON(w, http.StatusOK, map[string]any{
				"events": []any{},
			})
		case msg := <-pubCh:
			// Chat safety: filter message events for blocked senders / hidden moderation actions.
			deliver := true
			if dbPool != nil && strings.HasPrefix(strings.TrimSpace(msg.Payload), "{") {
				var ce chatEvent
				if err := json.Unmarshal([]byte(msg.Payload), &ce); err == nil && strings.HasPrefix(ce.EventType, "message.") {
					var mp struct {
						Message struct {
							ID            string `json:"id"`
							SenderUserID string `json:"sender_user_id"`
						} `json:"message"`
					}
					if err := json.Unmarshal(ce.Payload, &mp); err == nil && strings.TrimSpace(mp.Message.ID) != "" {
						messageID := strings.TrimSpace(mp.Message.ID)

						// moderation hidden?
						queryCtx, queryCancel := context.WithTimeout(context.Background(), 1*time.Second)
						var hidden bool
						err2 := dbPool.QueryRow(queryCtx, `
							SELECT EXISTS(
								SELECT 1
								FROM moderation_report mr
								INNER JOIN moderation_action ma ON ma.report_id = mr.id
								WHERE mr.target_type = 'message'
								  AND mr.target_id = $1::uuid
								  AND ma.action_type IN ('hide_content', 'remove_content')
								  AND (ma.expires_at IS NULL OR ma.expires_at > now())
								LIMIT 1
							)`, messageID).Scan(&hidden)
						queryCancel()
						if err2 == nil && hidden {
							deliver = false
						}

						// blocking?
						if deliver && strings.TrimSpace(mp.Message.SenderUserID) != "" {
							senderID := strings.TrimSpace(mp.Message.SenderUserID)
							queryCtx2, queryCancel2 := context.WithTimeout(context.Background(), 1*time.Second)
							var blocked bool
							err3 := dbPool.QueryRow(queryCtx2, `
								SELECT EXISTS(
									SELECT 1
									FROM user_block
									WHERE (blocker_user_id = $1::uuid AND blocked_user_id = $2::uuid)
									   OR (blocker_user_id = $2::uuid AND blocked_user_id = $1::uuid)
									LIMIT 1
								)`, viewerUserID, senderID).Scan(&blocked)
							queryCancel2()
							if err3 == nil && blocked {
								deliver = false
							}
						}
					}
				}
			}

			var event any
			if !deliver {
				event = nil
			} else if err := json.Unmarshal([]byte(msg.Payload), &event); err != nil {
				event = map[string]any{"raw": msg.Payload}
			}
			if !deliver {
				writeJSON(w, http.StatusOK, map[string]any{
					"events": []any{},
				})
			} else {
				writeJSON(w, http.StatusOK, map[string]any{
					"events": []any{event},
				})
			}
		}
	}
}

func notifyLongPollEventsHandler(redisClient *redis.Client, jwtSecrets []string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}

		token := r.URL.Query().Get("token")
		if token == "" {
			token = extractBearerToken(r)
		}
		claims, err := parseRealtimeToken(token, jwtSecrets, "")
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
			return
		}
		if strings.TrimSpace(claims.Typ) != "notify" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "notification token required"})
			return
		}
		userID := claims.Subject

		timeoutSec := 25
		if rawTimeout := r.URL.Query().Get("timeoutSec"); rawTimeout != "" {
			if n, err := strconv.Atoi(rawTimeout); err == nil {
				if n < 1 {
					n = 1
				}
				if n > 55 {
					n = 55
				}
				timeoutSec = n
			}
		}

		ctx, cancel := context.WithTimeout(r.Context(), time.Duration(timeoutSec)*time.Second)
		defer cancel()

		sub := redisClient.Subscribe(ctx, redisChannelForUserNotify(userID))
		defer sub.Close()
		pubCh := sub.Channel()

		select {
		case <-ctx.Done():
			writeJSON(w, http.StatusOK, map[string]any{
				"events": []any{},
			})
		case msg := <-pubCh:
			var event any
			if err := json.Unmarshal([]byte(msg.Payload), &event); err != nil {
				event = map[string]any{"raw": msg.Payload}
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"events": []any{event},
			})
		}
	}
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	databaseURL := os.Getenv("DATABASE_URL")
	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		redisURL = "redis://localhost:6379"
	}
	jwtAccessSecret := os.Getenv("JWT_ACCESS_SECRET")
	jwtLegacySecret := os.Getenv("JWT_SECRET")
	jwtSecrets := []string{jwtAccessSecret, jwtLegacySecret}
	if strings.TrimSpace(jwtAccessSecret) == "" && strings.TrimSpace(jwtLegacySecret) == "" {
		jwtSecrets = []string{"dev_jwt_secret"}
	}
	internalKey := os.Getenv("CHAT_INTERNAL_API_KEY")

	redisOpt, err := redis.ParseURL(redisURL)
	if err != nil {
		log.Fatalf("invalid REDIS_URL: %v", err)
	}
	redisClient := redis.NewClient(redisOpt)
	defer redisClient.Close()

	var dbPool *pgxpool.Pool
	if strings.TrimSpace(databaseURL) != "" {
		p, err := pgxpool.New(context.Background(), databaseURL)
		if err != nil {
			log.Printf("pg pool for internal history/aggregate disabled: %v", err)
		} else {
			dbPool = p
			defer dbPool.Close()
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", healthHandler(port))
	mux.HandleFunc("/health/deps", depsHealthHandler(databaseURL, redisClient))
	mux.HandleFunc("/ws", wsHandler(redisClient, jwtSecrets, dbPool))
	mux.HandleFunc("/realtime/rooms/", longPollEventsHandler(redisClient, jwtSecrets, dbPool))
	mux.HandleFunc("/realtime/notify/events", notifyLongPollEventsHandler(redisClient, jwtSecrets))
	mux.HandleFunc("/internal/chat/publish", publishHandler(redisClient, internalKey))
	mux.HandleFunc("/internal/notify/publish", notifyPublishHandler(redisClient, internalKey))

	if dbPool != nil {
		mux.HandleFunc("GET /internal/history/rooms/{roomId}/messages", listMessagesHandler(redisClient, dbPool, internalKey))
		mux.HandleFunc("POST /internal/history/rooms/{roomId}/messages", postMessageHandler(redisClient, dbPool, internalKey))
		mux.HandleFunc("PATCH /internal/history/rooms/{roomId}/messages/{messageId}", patchMessageHandler(redisClient, dbPool, internalKey))
		mux.HandleFunc("DELETE /internal/history/rooms/{roomId}/messages/{messageId}", deleteMessageHandler(redisClient, dbPool, internalKey))
		mux.HandleFunc("GET /internal/live/sessions/{sessionId}/aggregate", liveSessionAggregateHandler(redisClient, dbPool, internalKey))
	}
	mux.HandleFunc("GET /internal/ledger/health", ledgerHealthHandler(internalKey))
	mux.HandleFunc("POST /internal/ledger/transfer", ledgerTransferStubHandler(internalKey))

	mchat := newChatMetrics()
	var handler http.Handler = mux
	if metricsEnabledGo() {
		mux.HandleFunc("/metrics", metricsHandler(mchat))
		handler = withChatRequestMetrics(mchat, mux)
	}

	addr := ":" + port
	log.Printf("chat service listening on %s", addr)
	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatal(err)
	}
}
