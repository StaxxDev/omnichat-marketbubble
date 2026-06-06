package main

import (
	"context"
	"fmt"
	"log"
	"math/rand"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

const twitchURL = "wss://irc-ws.chat.twitch.tv:443"

// StartTwitch connects to Twitch anonymous IRC over WebSocket and joins the
// given channel logins. It reconnects with exponential backoff on drop.
func StartTwitch(ctx context.Context, hub *Hub, channels []string) {
	if len(channels) == 0 {
		return
	}
	go func() {
		backoff := time.Second
		for {
			if ctx.Err() != nil {
				return
			}
			err := twitchSession(ctx, hub, channels)
			if ctx.Err() != nil {
				return
			}
			if err != nil {
				log.Printf("[twitch] session ended: %v (reconnect in %s)", err, backoff)
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

func twitchSession(ctx context.Context, hub *Hub, channels []string) error {
	dialCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	conn, _, err := websocket.DefaultDialer.DialContext(dialCtx, twitchURL, nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	send := func(line string) error {
		return conn.WriteMessage(websocket.TextMessage, []byte(line+"\r\n"))
	}

	if err := send("CAP REQ :twitch.tv/tags twitch.tv/commands"); err != nil {
		return err
	}
	if err := send(fmt.Sprintf("NICK justinfan%d", 10000+rand.Intn(89999))); err != nil {
		return err
	}
	for _, ch := range channels {
		login := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(ch), "#"))
		if login == "" {
			continue
		}
		if err := send("JOIN #" + login); err != nil {
			return err
		}
	}
	log.Printf("[twitch] connected, joined: %s", strings.Join(channels, ", "))

	// Close the conn when ctx is cancelled to unblock ReadMessage.
	go func() {
		<-ctx.Done()
		_ = conn.Close()
	}()

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		for _, line := range strings.Split(string(data), "\r\n") {
			if line == "" {
				continue
			}
			if strings.HasPrefix(line, "PING") {
				_ = send("PONG :tmi.twitch.tv")
				continue
			}
			if msg, ok := parseTwitchLine(line); ok {
				hub.Publish(msg)
			}
		}
	}
}

// parseTwitchLine parses an IRC PRIVMSG line into a unified Message.
func parseTwitchLine(line string) (Message, bool) {
	if !strings.Contains(line, " PRIVMSG ") {
		return Message{}, false
	}

	tags := map[string]string{}
	if strings.HasPrefix(line, "@") {
		sp := strings.SplitN(line, " ", 2)
		tagStr := strings.TrimPrefix(sp[0], "@")
		if len(sp) == 2 {
			line = sp[1]
		}
		for _, kv := range strings.Split(tagStr, ";") {
			parts := strings.SplitN(kv, "=", 2)
			if len(parts) == 2 {
				tags[parts[0]] = parts[1]
			}
		}
	}

	// channel = between "PRIVMSG #" and " :"
	pi := strings.Index(line, "PRIVMSG #")
	if pi < 0 {
		return Message{}, false
	}
	rest := line[pi+len("PRIVMSG #"):]
	ci := strings.Index(rest, " :")
	if ci < 0 {
		return Message{}, false
	}
	channel := rest[:ci]
	text := rest[ci+2:] // everything after the first " :" following PRIVMSG

	author := tags["display-name"]
	if author == "" {
		// fall back to nick from :nick!...
		if bang := strings.Index(line, "!"); strings.HasPrefix(line, ":") && bang > 0 {
			author = line[1:bang]
		}
	}
	if author == "" {
		author = "anon"
	}

	id := tags["id"]
	if id == "" {
		id = fmt.Sprintf("tw-%s-%d-%s", channel, nowMs(), randID())
	}

	return Message{
		ID:      id,
		Source:  "twitch",
		Channel: channel,
		Author:  author,
		Text:    stripNewlines(text),
		Color:   tags["color"],
		TS:      nowMs(),
	}, true
}
