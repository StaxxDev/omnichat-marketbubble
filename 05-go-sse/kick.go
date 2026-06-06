package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

const (
	kickPusherURL = "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false"
	browserUA     = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

// StartKick resolves chatroom ids for slugs (or uses overrides) and connects to
// Kick's Pusher socket, reconnecting with backoff. chatroomIDs aligns to slugs.
func StartKick(ctx context.Context, hub *Hub, slugs []string, chatroomIDs []string) {
	if len(slugs) == 0 {
		return
	}

	// Resolve chatroom ids -> slug map for channel labels.
	rooms := map[string]string{} // chatroomID -> slug label
	for i, slug := range slugs {
		slug = strings.TrimSpace(slug)
		if slug == "" {
			continue
		}
		var id string
		if i < len(chatroomIDs) && strings.TrimSpace(chatroomIDs[i]) != "" {
			id = strings.TrimSpace(chatroomIDs[i])
		} else {
			resolved, err := resolveKickChatroom(ctx, slug)
			if err != nil {
				log.Printf("[kick] could not resolve chatroom for %q: %v (set KICK_CHATROOM_IDS to override)", slug, err)
				continue
			}
			id = resolved
		}
		rooms[id] = slug
	}
	if len(rooms) == 0 {
		log.Printf("[kick] no chatrooms resolved; kick connector idle")
		return
	}

	go func() {
		backoff := time.Second
		for {
			if ctx.Err() != nil {
				return
			}
			err := kickSession(ctx, hub, rooms)
			if ctx.Err() != nil {
				return
			}
			if err != nil {
				log.Printf("[kick] session ended: %v (reconnect in %s)", err, backoff)
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
		}
	}()
}

func resolveKickChatroom(ctx context.Context, slug string) (string, error) {
	url := "https://kick.com/api/v2/channels/" + slug
	reqCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	req.Header.Set("User-Agent", browserUA)
	req.Header.Set("Accept", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("status %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	var parsed struct {
		Chatroom struct {
			ID int64 `json:"id"`
		} `json:"chatroom"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", err
	}
	if parsed.Chatroom.ID == 0 {
		return "", fmt.Errorf("no chatroom id in response")
	}
	return fmt.Sprintf("%d", parsed.Chatroom.ID), nil
}

func kickSession(ctx context.Context, hub *Hub, rooms map[string]string) error {
	dialCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	conn, _, err := websocket.DefaultDialer.DialContext(dialCtx, kickPusherURL, nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	go func() {
		<-ctx.Done()
		_ = conn.Close()
	}()

	writeJSON := func(v any) error { return conn.WriteJSON(v) }

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}

		var frame struct {
			Event   string `json:"event"`
			Channel string `json:"channel"`
			Data    string `json:"data"`
		}
		if err := json.Unmarshal(data, &frame); err != nil {
			continue
		}

		switch {
		case frame.Event == "pusher:connection_established":
			for id := range rooms {
				sub := map[string]any{
					"event": "pusher:subscribe",
					"data": map[string]string{
						"auth":    "",
						"channel": "chatrooms." + id + ".v2",
					},
				}
				_ = writeJSON(sub)
			}
			log.Printf("[kick] connected, subscribed to %d chatroom(s)", len(rooms))

		case frame.Event == "pusher:ping":
			_ = writeJSON(map[string]any{"event": "pusher:pong", "data": map[string]any{}})

		case frame.Event == "App\\Events\\ChatMessage":
			msg, ok := parseKickMessage(frame.Channel, frame.Data, rooms)
			if ok {
				hub.Publish(msg)
			}
		}
	}
}

func parseKickMessage(channel, dataStr string, rooms map[string]string) (Message, bool) {
	var payload struct {
		ID      string `json:"id"`
		Content string `json:"content"`
		Sender  struct {
			Username string `json:"username"`
			Identity struct {
				Color string `json:"color"`
			} `json:"identity"`
		} `json:"sender"`
	}
	if err := json.Unmarshal([]byte(dataStr), &payload); err != nil {
		return Message{}, false
	}

	// channel looks like "chatrooms.{id}.v2" -> map id back to slug label.
	label := channel
	parts := strings.Split(channel, ".")
	if len(parts) >= 2 {
		if slug, ok := rooms[parts[1]]; ok {
			label = slug
		}
	}

	id := payload.ID
	if id == "" {
		id = fmt.Sprintf("ki-%s-%d-%s", label, nowMs(), randID())
	}

	return Message{
		ID:      id,
		Source:  "kick",
		Channel: label,
		Author:  payload.Sender.Username,
		Text:    stripNewlines(payload.Content),
		Color:   payload.Sender.Identity.Color,
		TS:      nowMs(),
	}, true
}
