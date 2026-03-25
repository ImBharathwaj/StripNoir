package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

func liveSessionAggregateHandler(redisClient *redis.Client, pool *pgxpool.Pool, internalKey string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		if internalKey != "" && r.Header.Get("x-internal-key") != internalKey {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized internal"})
			return
		}

		sessionID := r.PathValue("sessionId")
		if strings.TrimSpace(sessionID) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "sessionId required"})
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()

		var roomID sql.NullString
		var dbViewers int
		err := pool.QueryRow(ctx, `
			SELECT ls.room_id::text,
			       COALESCE((
			         SELECT COUNT(*)::int FROM live_session_viewer lsv
			         WHERE lsv.live_session_id = ls.id AND lsv.is_active = TRUE
			       ), 0)
			FROM live_session ls
			WHERE ls.id = $1::uuid`, sessionID).Scan(&roomID, &dbViewers)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "live session not found"})
				return
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "aggregate query failed"})
			return
		}

		wsCount := int64(0)
		rid := ""
		if roomID.Valid && roomID.String != "" {
			rid = roomID.String
			n, err := redisClient.SCard(ctx, redisWSPresenceSetKey(rid)).Result()
			if err == nil {
				wsCount = n
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"liveSessionId":         sessionID,
			"roomId":              rid,
			"dbActiveViewers":     dbViewers,
			"wsViewerConnections": wsCount,
			"source":              "go_aggregate",
		})
	}
}
