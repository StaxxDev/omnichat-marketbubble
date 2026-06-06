package main

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"strings"
	"time"
)

func nowMs() int64 { return time.Now().UnixNano() / 1e6 }

// randID returns a short random hex token.
func randID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// env returns the env var or a fallback.
func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

// csv splits a comma-separated env value into trimmed, non-empty items.
func csv(key string) []string {
	raw := os.Getenv(key)
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// stripNewlines collapses newlines/tabs to spaces for single-line rendering.
func stripNewlines(s string) string {
	s = strings.ReplaceAll(s, "\r", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\t", " ")
	return strings.TrimSpace(s)
}
