package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"time"
)

// StartX polls the X/Twitter recent-search API every ~12s and streams new
// tweets as the X feed. If no bearer token is set it does nothing (no crash).
func StartX(ctx context.Context, hub *Hub, bearer, mode, target string) {
	if bearer == "" || target == "" {
		log.Printf("[x] disabled (need X_BEARER_TOKEN + X_TARGET)")
		return
	}

	var query string
	switch mode {
	case "replies":
		query = "conversation_id:" + target
	case "mentions":
		query = "@" + target + " -is:retweet"
	case "hashtag":
		query = "#" + target + " -is:retweet"
	default:
		query = "@" + target + " -is:retweet"
		mode = "mentions"
	}
	log.Printf("[x] polling mode=%s target=%s", mode, target)

	go func() {
		var sinceID string
		backoff := 12 * time.Second
		ticker := time.NewTimer(0)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}

			newSince, rateLimited, err := pollX(ctx, hub, bearer, query, sinceID)
			if err != nil {
				log.Printf("[x] poll error: %v", err)
			}
			if newSince != "" {
				sinceID = newSince
			}

			next := 12 * time.Second
			if rateLimited {
				backoff *= 2
				if backoff > 5*time.Minute {
					backoff = 5 * time.Minute
				}
				next = backoff
				log.Printf("[x] rate limited; backing off %s", next)
			} else {
				backoff = 12 * time.Second
			}
			ticker.Reset(next)
		}
	}()
}

func pollX(ctx context.Context, hub *Hub, bearer, query, sinceID string) (string, bool, error) {
	q := url.Values{}
	q.Set("query", query)
	q.Set("max_results", "100")
	q.Set("tweet.fields", "created_at,author_id")
	q.Set("expansions", "author_id")
	q.Set("user.fields", "username")
	if sinceID != "" {
		q.Set("since_id", sinceID)
	}
	endpoint := "https://api.twitter.com/2/tweets/search/recent?" + q.Encode()

	reqCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(reqCtx, http.MethodGet, endpoint, nil)
	req.Header.Set("Authorization", "Bearer "+bearer)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", false, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode == 429 {
		return "", true, fmt.Errorf("429 rate limited")
	}
	if resp.StatusCode != 200 {
		return "", false, fmt.Errorf("status %d: %s", resp.StatusCode, truncate(string(body), 200))
	}

	var parsed struct {
		Data []struct {
			ID       string `json:"id"`
			Text     string `json:"text"`
			AuthorID string `json:"author_id"`
		} `json:"data"`
		Includes struct {
			Users []struct {
				ID       string `json:"id"`
				Username string `json:"username"`
			} `json:"users"`
		} `json:"includes"`
		Meta struct {
			NewestID string `json:"newest_id"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", false, err
	}

	users := map[string]string{}
	for _, u := range parsed.Includes.Users {
		users[u.ID] = u.Username
	}

	// data[] is newest-first -> reverse to chronological.
	for i := len(parsed.Data) - 1; i >= 0; i-- {
		t := parsed.Data[i]
		uname := users[t.AuthorID]
		if uname == "" {
			uname = "user"
		}
		hub.Publish(Message{
			ID:      "x-" + t.ID,
			Source:  "x",
			Channel: query,
			Author:  uname,
			Text:    stripNewlines(t.Text),
			Color:   "",
			TS:      nowMs(),
		})
	}

	return parsed.Meta.NewestID, false, nil
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
