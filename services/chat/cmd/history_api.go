package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

const delegateUserHeader = "X-Delegate-User-Id"

func requireInternalHistoryAccess(w http.ResponseWriter, r *http.Request, internalKey string) (userID string, ok bool) {
	if internalKey != "" && r.Header.Get("x-internal-key") != internalKey {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized internal"})
		return "", false
	}
	userID = strings.TrimSpace(r.Header.Get(delegateUserHeader))
	if userID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": delegateUserHeader + " required"})
		return "", false
	}
	return userID, true
}

func confirmParticipant(ctx context.Context, pool *pgxpool.Pool, roomID, userID string) (bool, error) {
	var ok bool
	err := pool.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM chat_room_participant
			WHERE room_id = $1::uuid AND user_id = $2::uuid AND left_at IS NULL
		)`, roomID, userID).Scan(&ok)
	return ok, err
}

func publishRoomChatEvent(ctx context.Context, redisClient *redis.Client, roomID, eventType string, payload json.RawMessage) error {
	if len(payload) == 0 {
		payload = json.RawMessage(`{}`)
	}
	event := chatEvent{
		RoomID:    roomID,
		EventType: eventType,
		Payload:   payload,
		SentAt:    time.Now().UTC(),
	}
	raw, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return redisClient.Publish(ctx, redisChannelForRoom(roomID), raw).Err()
}

func listMessagesHandler(redisClient *redis.Client, pool *pgxpool.Pool, internalKey string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		userID, ok := requireInternalHistoryAccess(w, r, internalKey)
		if !ok {
			return
		}
		roomID := r.PathValue("roomId")
		if strings.TrimSpace(roomID) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "roomId required"})
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()

		part, err := confirmParticipant(ctx, pool, roomID, userID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to verify membership"})
			return
		}
		if !part {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "not a participant of this room"})
			return
		}

		// Chat safety: enforce user blocking for direct-room message reads.
		// If either participant blocked the other, we block message visibility entirely.
		var otherUserID string
		_ = pool.QueryRow(ctx, `
			SELECT user_id::text
			FROM chat_room_participant
			WHERE room_id = $1::uuid
			  AND user_id <> $2::uuid
			  AND left_at IS NULL
			LIMIT 1`, roomID, userID).Scan(&otherUserID)
		if strings.TrimSpace(otherUserID) != "" {
			var blocked bool
			_ = pool.QueryRow(ctx, `
				SELECT EXISTS(
					SELECT 1
					FROM user_block
					WHERE (blocker_user_id = $1::uuid AND blocked_user_id = $2::uuid)
					   OR (blocker_user_id = $2::uuid AND blocked_user_id = $1::uuid)
					LIMIT 1
				)`, userID, otherUserID).Scan(&blocked)
			if blocked {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "messages unavailable due to blocking"})
				return
			}
		}

		limit := 50
		if v := r.URL.Query().Get("limit"); v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				if n < 1 {
					n = 1
				}
				if n > 100 {
					n = 100
				}
				limit = n
			}
		}
		before := strings.TrimSpace(r.URL.Query().Get("before"))

		rows, err := pool.Query(ctx, `
			SELECT id::text, room_id::text, sender_user_id::text, body, attachments, status, sent_at, edited_at, deleted_at
			FROM message
			WHERE room_id = $1::uuid
			  AND context = 'direct'
			  AND NOT EXISTS (
				SELECT 1
				FROM moderation_report mr
				INNER JOIN moderation_action ma ON ma.report_id = mr.id
				WHERE mr.target_type = 'message'
				  AND mr.target_id = message.id
				  AND ma.action_type IN ('hide_content', 'remove_content')
				  AND (ma.expires_at IS NULL OR ma.expires_at > now())
				LIMIT 1
			  )
			  AND ($2::timestamptz IS NULL OR sent_at < $2::timestamptz)
			ORDER BY sent_at DESC
			LIMIT $3`, roomID, nullIfEmpty(before), limit)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to fetch messages"})
			return
		}
		defer rows.Close()

		var list []map[string]any
		for rows.Next() {
			var id, rid, sid, body, status string
			var attachments []byte
			var sentAt, editedAt, deletedAt *time.Time
			if err := rows.Scan(&id, &rid, &sid, &body, &attachments, &status, &sentAt, &editedAt, &deletedAt); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "scan failed"})
				return
			}
			var att any
			_ = json.Unmarshal(attachments, &att)
			m := map[string]any{
				"id": id, "room_id": rid, "sender_user_id": sid, "body": body, "attachments": att, "status": status,
			}
			if sentAt != nil {
				m["sent_at"] = sentAt
			}
			if editedAt != nil {
				m["edited_at"] = editedAt
			}
			if deletedAt != nil {
				m["deleted_at"] = deletedAt
			}
			list = append(list, m)
		}
		// reverse to chronological ascending (match Node)
		for i, j := 0, len(list)-1; i < j; i, j = i+1, j-1 {
			list[i], list[j] = list[j], list[i]
		}
		writeJSON(w, http.StatusOK, map[string]any{"messages": list})
	}
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func listRoomSummaryHandler(pool *pgxpool.Pool, internalKey string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		userID, ok := requireInternalHistoryAccess(w, r, internalKey)
		if !ok {
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()

		rows, err := pool.Query(ctx, `
			SELECT cr.id::text,
			       cr.room_type,
			       cr.subject,
			       cr.created_at,
			       cr.updated_at,
			       other.user_id::text AS other_participant_user_id,
			       ua.username AS other_participant_username,
			       ua.display_name AS other_participant_display_name,
			       ua.avatar_url AS other_participant_avatar_url,
			       lm.id::text AS last_message_id,
			       lm.sender_user_id::text AS last_message_sender_user_id,
			       lm.body AS last_message_body,
			       lm.status AS last_message_status,
			       lm.sent_at AS last_message_sent_at,
			       lm.edited_at AS last_message_edited_at,
			       lm.deleted_at AS last_message_deleted_at,
			       COALESCE(uc.unread_count, 0)::int AS unread_count
			FROM chat_room cr
			INNER JOIN chat_room_participant me
			  ON me.room_id = cr.id
			 AND me.user_id = $1::uuid
			 AND me.left_at IS NULL
			LEFT JOIN LATERAL (
			  SELECT p.user_id
			  FROM chat_room_participant p
			  WHERE p.room_id = cr.id
			    AND p.user_id <> $1::uuid
			    AND p.left_at IS NULL
			  ORDER BY p.joined_at ASC
			  LIMIT 1
			) other ON TRUE
			LEFT JOIN user_account ua
			  ON ua.id = other.user_id
			LEFT JOIN LATERAL (
			  SELECT m.id, m.sender_user_id, m.body, m.status, m.sent_at, m.edited_at, m.deleted_at
			  FROM message m
			  WHERE m.room_id = cr.id
			    AND m.context = 'direct'
			  ORDER BY m.sent_at DESC
			  LIMIT 1
			) lm ON TRUE
			LEFT JOIN LATERAL (
			  SELECT COUNT(*)::int AS unread_count
			  FROM message m2
			  LEFT JOIN chat_room_read_state rs
			    ON rs.room_id = cr.id
			   AND rs.user_id = $1::uuid
			  WHERE m2.room_id = cr.id
			    AND m2.context = 'direct'
			    AND m2.sender_user_id <> $1::uuid
			    AND (
			      rs.last_read_at IS NULL
			      OR m2.sent_at > rs.last_read_at
			    )
			) uc ON TRUE
			WHERE cr.is_active = TRUE
			ORDER BY COALESCE(lm.sent_at, cr.updated_at, cr.created_at) DESC
			LIMIT 100`, userID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to fetch chat room summary"})
			return
		}
		defer rows.Close()

		rooms := make([]map[string]any, 0)
		for rows.Next() {
			var roomID, roomType string
			var subject *string
			var createdAt, updatedAt *time.Time
			var otherUserID, otherUsername, otherDisplayName, otherAvatarURL *string
			var lastMessageID, lastSenderUserID, lastMessageBody, lastMessageStatus *string
			var lastSentAt, lastEditedAt, lastDeletedAt *time.Time
			var unreadCount int
			if err := rows.Scan(
				&roomID,
				&roomType,
				&subject,
				&createdAt,
				&updatedAt,
				&otherUserID,
				&otherUsername,
				&otherDisplayName,
				&otherAvatarURL,
				&lastMessageID,
				&lastSenderUserID,
				&lastMessageBody,
				&lastMessageStatus,
				&lastSentAt,
				&lastEditedAt,
				&lastDeletedAt,
				&unreadCount,
			); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to scan chat room summary"})
				return
			}

			room := map[string]any{
				"id":          roomID,
				"roomType":    roomType,
				"subject":     subject,
				"createdAt":   createdAt,
				"updatedAt":   updatedAt,
				"unreadCount": unreadCount,
			}
			if otherUserID != nil && strings.TrimSpace(*otherUserID) != "" {
				room["otherParticipant"] = map[string]any{
					"userId":      *otherUserID,
					"username":    otherUsername,
					"displayName": otherDisplayName,
					"avatarUrl":   otherAvatarURL,
				}
			} else {
				room["otherParticipant"] = nil
			}
			if lastMessageID != nil && strings.TrimSpace(*lastMessageID) != "" {
				room["lastMessage"] = map[string]any{
					"id":           *lastMessageID,
					"senderUserId": lastSenderUserID,
					"body":         lastMessageBody,
					"status":       lastMessageStatus,
					"sentAt":       lastSentAt,
					"editedAt":     lastEditedAt,
					"deletedAt":    lastDeletedAt,
				}
			} else {
				room["lastMessage"] = nil
			}
			rooms = append(rooms, room)
		}

		writeJSON(w, http.StatusOK, map[string]any{"rooms": rooms})
	}
}

func markRoomReadHandler(redisClient *redis.Client, pool *pgxpool.Pool, internalKey string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		userID, ok := requireInternalHistoryAccess(w, r, internalKey)
		if !ok {
			return
		}
		roomID := r.PathValue("roomId")
		var body struct {
			LastReadMessageID string `json:"lastReadMessageId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil && err.Error() != "EOF" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
			return
		}
		lastReadMessageID := strings.TrimSpace(body.LastReadMessageID)

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()

		part, err := confirmParticipant(ctx, pool, roomID, userID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to verify membership"})
			return
		}
		if !part {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "not a participant of this room"})
			return
		}

		if lastReadMessageID != "" {
			var exists bool
			err = pool.QueryRow(ctx, `
				SELECT EXISTS(
					SELECT 1
					FROM message
					WHERE id = $1::uuid
					  AND room_id = $2::uuid
					LIMIT 1
				)`, lastReadMessageID, roomID).Scan(&exists)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to validate lastReadMessageId"})
				return
			}
			if !exists {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "lastReadMessageId does not belong to this room"})
				return
			}
		}

		var readRoomID, readUserID string
		var readMessageID *string
		var lastReadAt, updatedAt *time.Time
		err = pool.QueryRow(ctx, `
			INSERT INTO chat_room_read_state (room_id, user_id, last_read_message_id, last_read_at)
			VALUES ($1::uuid, $2::uuid, $3::uuid, now())
			ON CONFLICT (room_id, user_id)
			DO UPDATE SET
			  last_read_message_id = EXCLUDED.last_read_message_id,
			  last_read_at = EXCLUDED.last_read_at,
			  updated_at = now()
			RETURNING room_id::text, user_id::text, last_read_message_id::text, last_read_at, updated_at`,
			roomID, userID, nullIfEmpty(lastReadMessageID),
		).Scan(&readRoomID, &readUserID, &readMessageID, &lastReadAt, &updatedAt)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to update read state"})
			return
		}

		payload, _ := json.Marshal(map[string]any{
			"roomId":            roomID,
			"userId":            userID,
			"lastReadMessageId": readMessageID,
			"lastReadAt":        lastReadAt,
		})
		pubCtx, pubCancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer pubCancel()
		if err := publishRoomChatEvent(pubCtx, redisClient, roomID, "room.read", payload); err != nil {
			log.Printf("history publish room.read: %v", err)
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"readState": map[string]any{
				"room_id":              readRoomID,
				"user_id":              readUserID,
				"last_read_message_id": readMessageID,
				"last_read_at":         lastReadAt,
				"updated_at":           updatedAt,
			},
		})
	}
}

func postMessageHandler(redisClient *redis.Client, pool *pgxpool.Pool, internalKey string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		userID, ok := requireInternalHistoryAccess(w, r, internalKey)
		if !ok {
			return
		}
		roomID := r.PathValue("roomId")
		var body struct {
			Body string `json:"body"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
			return
		}
		b := strings.TrimSpace(body.Body)
		if b == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "body is required"})
			return
		}
		if len(b) > 4000 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "body is too long"})
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()

		part, err := confirmParticipant(ctx, pool, roomID, userID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to verify membership"})
			return
		}
		if !part {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "not a participant of this room"})
			return
		}

		// Chat safety: enforce user blocking for direct-room message writes.
		var otherUserID string
		_ = pool.QueryRow(ctx, `
			SELECT user_id::text
			FROM chat_room_participant
			WHERE room_id = $1::uuid
			  AND user_id <> $2::uuid
			  AND left_at IS NULL
			LIMIT 1`, roomID, userID).Scan(&otherUserID)
		if strings.TrimSpace(otherUserID) != "" {
			var blocked bool
			_ = pool.QueryRow(ctx, `
				SELECT EXISTS(
					SELECT 1
					FROM user_block
					WHERE (blocker_user_id = $1::uuid AND blocked_user_id = $2::uuid)
					   OR (blocker_user_id = $2::uuid AND blocked_user_id = $1::uuid)
					LIMIT 1
				)`, userID, otherUserID).Scan(&blocked)
			if blocked {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "cannot send messages due to blocking"})
				return
			}
		}

		tx, err := pool.Begin(ctx)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "tx begin failed"})
			return
		}
		defer tx.Rollback(ctx)

		var id, rid, sid, outBody, status string
		var attachments []byte
		var sentAt, editedAt, deletedAt *time.Time
		err = tx.QueryRow(ctx, `
			INSERT INTO message (room_id, context, sender_user_id, body, attachments, status)
			VALUES ($1::uuid, 'direct', $2::uuid, $3, '[]'::jsonb, 'sent')
			RETURNING id::text, room_id::text, sender_user_id::text, body, attachments, status, sent_at, edited_at, deleted_at`,
			roomID, userID, b).Scan(&id, &rid, &sid, &outBody, &attachments, &status, &sentAt, &editedAt, &deletedAt)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to send message"})
			return
		}
		_, _ = tx.Exec(ctx, `UPDATE chat_room SET updated_at = now() WHERE id = $1::uuid`, roomID)
		if err := tx.Commit(ctx); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "commit failed"})
			return
		}

		var att any
		_ = json.Unmarshal(attachments, &att)
		msg := map[string]any{
			"id": id, "room_id": rid, "sender_user_id": sid, "body": outBody, "attachments": att, "status": status,
		}
		if sentAt != nil {
			msg["sent_at"] = sentAt
		}
		if editedAt != nil {
			msg["edited_at"] = editedAt
		}
		if deletedAt != nil {
			msg["deleted_at"] = deletedAt
		}
		pl, _ := json.Marshal(map[string]any{"message": msg})
		pubCtx, pubCancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer pubCancel()
		if err := publishRoomChatEvent(pubCtx, redisClient, roomID, "message.created", pl); err != nil {
			log.Printf("history publish message.created: %v", err)
		}

		writeJSON(w, http.StatusCreated, map[string]any{"message": msg})
	}
}

func patchMessageHandler(redisClient *redis.Client, pool *pgxpool.Pool, internalKey string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		userID, ok := requireInternalHistoryAccess(w, r, internalKey)
		if !ok {
			return
		}
		roomID := r.PathValue("roomId")
		messageID := r.PathValue("messageId")
		var body struct {
			Body string `json:"body"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
			return
		}
		b := strings.TrimSpace(body.Body)
		if b == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "body is required"})
			return
		}
		if len(b) > 4000 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "body is too long"})
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()

		part, err := confirmParticipant(ctx, pool, roomID, userID)
		if err != nil || !part {
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to verify membership"})
				return
			}
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "not a participant of this room"})
			return
		}

		// Chat safety: enforce user blocking for direct-room message edits.
		var otherUserID string
		_ = pool.QueryRow(ctx, `
			SELECT user_id::text
			FROM chat_room_participant
			WHERE room_id = $1::uuid
			  AND user_id <> $2::uuid
			  AND left_at IS NULL
			LIMIT 1`, roomID, userID).Scan(&otherUserID)
		if strings.TrimSpace(otherUserID) != "" {
			var blocked bool
			_ = pool.QueryRow(ctx, `
				SELECT EXISTS(
					SELECT 1
					FROM user_block
					WHERE (blocker_user_id = $1::uuid AND blocked_user_id = $2::uuid)
					   OR (blocker_user_id = $2::uuid AND blocked_user_id = $1::uuid)
					LIMIT 1
				)`, userID, otherUserID).Scan(&blocked)
			if blocked {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "message edit blocked due to blocking"})
				return
			}
		}

		var id, rid, sid, outBody, status string
		var attachments []byte
		var sentAt, editedAt, deletedAt *time.Time
		err = pool.QueryRow(ctx, `
			UPDATE message
			SET body = $1, edited_at = now(), status = 'edited'
			WHERE id = $2::uuid AND room_id = $3::uuid AND context = 'direct'
			  AND sender_user_id = $4::uuid AND status <> 'deleted'
			RETURNING id::text, room_id::text, sender_user_id::text, body, attachments, status, sent_at, edited_at, deleted_at`,
			b, messageID, roomID, userID).Scan(&id, &rid, &sid, &outBody, &attachments, &status, &sentAt, &editedAt, &deletedAt)
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "message not found or not editable"})
			return
		}

		var att any
		_ = json.Unmarshal(attachments, &att)
		msg := map[string]any{
			"id": id, "room_id": rid, "sender_user_id": sid, "body": outBody, "attachments": att, "status": status,
		}
		if sentAt != nil {
			msg["sent_at"] = sentAt
		}
		if editedAt != nil {
			msg["edited_at"] = editedAt
		}
		if deletedAt != nil {
			msg["deleted_at"] = deletedAt
		}
		pl, _ := json.Marshal(map[string]any{"message": msg})
		pubCtx, pubCancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer pubCancel()
		_ = publishRoomChatEvent(pubCtx, redisClient, roomID, "message.edited", pl)

		writeJSON(w, http.StatusOK, map[string]any{"message": msg})
	}
}

func deleteMessageHandler(redisClient *redis.Client, pool *pgxpool.Pool, internalKey string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
		userID, ok := requireInternalHistoryAccess(w, r, internalKey)
		if !ok {
			return
		}
		roomID := r.PathValue("roomId")
		messageID := r.PathValue("messageId")

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()

		part, err := confirmParticipant(ctx, pool, roomID, userID)
		if err != nil || !part {
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to verify membership"})
				return
			}
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "not a participant of this room"})
			return
		}

		// Chat safety: enforce user blocking for direct-room message deletes.
		var otherUserID string
		_ = pool.QueryRow(ctx, `
			SELECT user_id::text
			FROM chat_room_participant
			WHERE room_id = $1::uuid
			  AND user_id <> $2::uuid
			  AND left_at IS NULL
			LIMIT 1`, roomID, userID).Scan(&otherUserID)
		if strings.TrimSpace(otherUserID) != "" {
			var blocked bool
			_ = pool.QueryRow(ctx, `
				SELECT EXISTS(
					SELECT 1
					FROM user_block
					WHERE (blocker_user_id = $1::uuid AND blocked_user_id = $2::uuid)
					   OR (blocker_user_id = $2::uuid AND blocked_user_id = $1::uuid)
					LIMIT 1
				)`, userID, otherUserID).Scan(&blocked)
			if blocked {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "message delete blocked due to blocking"})
				return
			}
		}

		var id, rid, sid, status string
		var sentAt, editedAt, deletedAt *time.Time
		err = pool.QueryRow(ctx, `
			UPDATE message
			SET status = 'deleted', deleted_at = now(), body = NULL, attachments = '[]'::jsonb
			WHERE id = $1::uuid AND room_id = $2::uuid AND context = 'direct'
			  AND sender_user_id = $3::uuid AND status <> 'deleted'
			RETURNING id::text, room_id::text, sender_user_id::text, status, sent_at, edited_at, deleted_at`,
			messageID, roomID, userID).Scan(&id, &rid, &sid, &status, &sentAt, &editedAt, &deletedAt)
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "message not found or not deletable"})
			return
		}

		msg := map[string]any{
			"id": id, "room_id": rid, "sender_user_id": sid, "status": status,
		}
		if sentAt != nil {
			msg["sent_at"] = sentAt
		}
		if editedAt != nil {
			msg["edited_at"] = editedAt
		}
		if deletedAt != nil {
			msg["deleted_at"] = deletedAt
		}
		pl, _ := json.Marshal(map[string]any{"message": msg})
		pubCtx, pubCancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer pubCancel()
		_ = publishRoomChatEvent(pubCtx, redisClient, roomID, "message.deleted", pl)

		writeJSON(w, http.StatusOK, map[string]any{"message": msg})
	}
}
