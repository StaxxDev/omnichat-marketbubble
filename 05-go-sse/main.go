package main

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

//go:embed static/*
var staticFS embed.FS

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	hub := NewHub(envInt("MAX_MESSAGES", 500))
	go hub.Run()

	// --- Read configuration ---
	twitchChannels := csv("TWITCH_CHANNELS")
	kickSlugs := csv("KICK_CHANNELS")
	kickRoomIDs := csv("KICK_CHATROOM_IDS")
	xBearer := env("X_BEARER_TOKEN", "")
	xMode := env("X_MODE", "mentions")
	xTarget := env("X_TARGET", "")

	configured := len(twitchChannels) > 0 || len(kickSlugs) > 0 || (xBearer != "" && xTarget != "")
	demo := os.Getenv("DEMO") == "1" || !configured

	if demo {
		StartDemo(ctx, hub)
	} else {
		StartTwitch(ctx, hub, twitchChannels)
		StartKick(ctx, hub, kickSlugs, kickRoomIDs)
		StartX(ctx, hub, xBearer, xMode, xTarget)
	}

	// --- HTTP server ---
	mux := http.NewServeMux()

	// Embedded static UI at /
	sub, err := fs.Sub(staticFS, "static")
	if err != nil {
		log.Fatalf("embed: %v", err)
	}
	mux.Handle("/", http.FileServer(http.FS(sub)))

	// SSE stream of merged messages.
	mux.HandleFunc("/events", func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")

		ch, history := hub.Subscribe()
		defer hub.Unsubscribe(ch)

		// Replay recent history so the feed isn't empty on connect.
		for _, m := range history {
			writeSSE(w, m)
		}
		flusher.Flush()

		keepalive := time.NewTicker(20 * time.Second)
		defer keepalive.Stop()

		for {
			select {
			case <-r.Context().Done():
				return
			case <-keepalive.C:
				_, _ = fmt.Fprint(w, ": keepalive\n\n")
				flusher.Flush()
			case m, ok := <-ch:
				if !ok {
					return
				}
				writeSSE(w, m)
				flusher.Flush()
			}
		}
	})

	// Tiny health/info endpoint.
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":     true,
			"demo":   demo,
			"twitch": twitchChannels,
			"kick":   kickSlugs,
			"x":      xTarget != "",
		})
	})

	port := env("PORT", "8080")
	srv := &http.Server{Addr: ":" + port, Handler: mux}

	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutCtx)
	}()

	log.Printf("OmniChat Go listening on http://localhost:%s  (demo=%v)", port, demo)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server: %v", err)
	}
}

func writeSSE(w http.ResponseWriter, m Message) {
	b, err := json.Marshal(m)
	if err != nil {
		return
	}
	_, _ = fmt.Fprintf(w, "data: %s\n\n", b)
}

func envInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}
