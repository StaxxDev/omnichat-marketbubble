package main

import (
	"sync"
)

// Message is the unified schema every connector emits.
type Message struct {
	ID      string `json:"id"`
	Source  string `json:"source"` // "twitch" | "x" | "kick"
	Channel string `json:"channel"`
	Author  string `json:"author"`
	Text    string `json:"text"`
	Color   string `json:"color"`
	TS      int64  `json:"ts"` // epoch ms
}

// Hub fans incoming messages out to all connected SSE clients and
// keeps a bounded ring buffer of recent messages for late joiners.
type Hub struct {
	mu       sync.RWMutex
	clients  map[chan Message]struct{}
	history  []Message
	maxKeep  int
	incoming chan Message
}

func NewHub(maxKeep int) *Hub {
	if maxKeep <= 0 {
		maxKeep = 500
	}
	return &Hub{
		clients:  make(map[chan Message]struct{}),
		history:  make([]Message, 0, maxKeep),
		maxKeep:  maxKeep,
		incoming: make(chan Message, 1024),
	}
}

// Publish is the entry point every connector calls.
func (h *Hub) Publish(m Message) {
	select {
	case h.incoming <- m:
	default:
		// Hub backlog full — drop oldest by skipping; never block a connector.
	}
}

// Run is the central dispatch loop. One goroutine owns all fan-out.
func (h *Hub) Run() {
	for m := range h.incoming {
		h.mu.Lock()
		h.history = append(h.history, m)
		if len(h.history) > h.maxKeep {
			h.history = h.history[len(h.history)-h.maxKeep:]
		}
		for ch := range h.clients {
			select {
			case ch <- m:
			default:
				// Slow client — drop this message for them rather than stall the hub.
			}
		}
		h.mu.Unlock()
	}
}

// Subscribe registers a new SSE client and returns its channel plus a
// snapshot of recent history so the feed isn't empty on connect.
func (h *Hub) Subscribe() (chan Message, []Message) {
	ch := make(chan Message, 256)
	h.mu.Lock()
	h.clients[ch] = struct{}{}
	snapshot := make([]Message, len(h.history))
	copy(snapshot, h.history)
	h.mu.Unlock()
	return ch, snapshot
}

func (h *Hub) Unsubscribe(ch chan Message) {
	h.mu.Lock()
	if _, ok := h.clients[ch]; ok {
		delete(h.clients, ch)
		close(ch)
	}
	h.mu.Unlock()
}
