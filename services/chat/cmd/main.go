package main

import (
	"context"
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
	RoomID    string          `json:"roomId"`
	EventType string          `json:"eventType"`
	Payload   json.RawMessage `json:"payload"`
	SentAt    time.Time       `json:"sentAt"`
}

type chatTokenClaims struct {
	RoomID string `json:"roomId"`
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

func validateChatToken(tokenString string, jwtSecrets []string, expectedRoomID string) (*chatTokenClaims, error) {
	if tokenString == "" {
		return nil, errors.New("token is required")
	}

	var lastErr error
	for _, secret := range jwtSecrets {
		if strings.TrimSpace(secret) == "" {
			continue
		}

		claims := &chatTokenClaims{}
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

		if claims.Typ != "chat" {
			return nil, errors.New("invalid token type")
		}
		if claims.Subject == "" {
			return nil, errors.New("token subject missing")
		}
		if claims.RoomID == "" {
			return nil, errors.New("token roomId missing")
		}
		if expectedRoomID != "" && claims.RoomID != expectedRoomID {
			return nil, errors.New("token room mismatch")
		}

		return claims, nil
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

func wsHandler(redisClient *redis.Client, jwtSecrets []string) http.HandlerFunc {
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

		claims, err := validateChatToken(token, jwtSecrets, requestedRoomID)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
			return
		}
		roomID := claims.RoomID

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()

		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		sub := redisClient.Subscribe(ctx, redisChannelForRoom(roomID))
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
}

func longPollEventsHandler(redisClient *redis.Client, jwtSecrets []string) http.HandlerFunc {
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
		if _, err := validateChatToken(token, jwtSecrets, roomID); err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
			return
		}

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

	mux := http.NewServeMux()
	mux.HandleFunc("/health", healthHandler(port))
	mux.HandleFunc("/health/deps", depsHealthHandler(databaseURL, redisClient))
	mux.HandleFunc("/ws", wsHandler(redisClient, jwtSecrets))
	mux.HandleFunc("/realtime/rooms/", longPollEventsHandler(redisClient, jwtSecrets))
	mux.HandleFunc("/internal/chat/publish", publishHandler(redisClient, internalKey))

	addr := ":" + port
	log.Printf("chat service listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}
