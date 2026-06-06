package main

import (
	"context"
	"fmt"
	"log"
	"math/rand"
	"time"
)

// StartDemo injects synthetic crypto-stream-flavored messages from all three
// sources every ~800ms so the merged, labeled, filterable feed works with zero config.
func StartDemo(ctx context.Context, hub *Hub) {
	log.Printf("[demo] DEMO MODE active — injecting synthetic messages")

	type src struct {
		source   string
		channel  string
		authors  []string
		colors   []string
	}
	sources := []src{
		{"twitch", "blknoiz06", []string{"degenApe", "chartWizard", "moonboy42", "rektRaccoon", "satoshiJr"},
			[]string{"#9146FF", "#FF4500", "#1E90FF", "#FFD700", "#FF69B4"}},
		{"kick", "ansem", []string{"liquidatedLarry", "pumpItPaul", "hodlHannah", "scalpSamantha"},
			[]string{"#53FC18", "#00E5FF", "#FF8C00", "#E040FB"}},
		{"x", "@blknoiz06", []string{"cryptoCassie", "alphaAndy", "ngmiNate", "wagmiWendy", "frogFren"},
			[]string{"", "", "", "", ""}},
	}
	lines := []string{
		"this candle is absolutely sending it 🚀",
		"who is buying this top lmao",
		"Ansem cooking again, up only",
		"gm degens, what are we aping today",
		"my portfolio is down bad but vibes immaculate",
		"that liquidation cascade was brutal",
		"SOL flipping ETH when",
		"new ATH incoming, screenshot this",
		"paper hands ngmi, diamond hands wagmi",
		"the chat is more bullish than the chart",
		"someone just longed the exact top again",
		"funding rates looking spicy rn",
		"ser, is this financial advice? (it is not)",
		"buying the dip with money I don't have",
		"this stream is the only alpha I need",
	}

	r := rand.New(rand.NewSource(time.Now().UnixNano()))
	ticker := time.NewTicker(800 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		s := sources[r.Intn(len(sources))]
		ai := r.Intn(len(s.authors))
		hub.Publish(Message{
			ID:      fmt.Sprintf("demo-%d-%s", nowMs(), randID()),
			Source:  s.source,
			Channel: s.channel,
			Author:  s.authors[ai],
			Text:    lines[r.Intn(len(lines))],
			Color:   s.colors[ai],
			TS:      nowMs(),
		})
	}
}
