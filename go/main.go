package main

import (
	"encoding/binary"
	"fmt"
	"math"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ebitengine/oto/v3"
)

const blockFrames = 1024

// ModReader implements io.Reader by pulling rendered audio from a ModPlayer.
type ModReader struct {
	player *ModPlayer
	buf    []byte
	bufPos int
}

func (r *ModReader) Read(p []byte) (int, error) {
	if r.bufPos >= len(r.buf) {
		// Render a new block of audio.
		frames := r.player.Render(blockFrames)
		r.buf = make([]byte, len(frames)*4)
		for i, f := range frames {
			bits := math.Float32bits(f)
			binary.LittleEndian.PutUint32(r.buf[i*4:], bits)
		}
		r.bufPos = 0
	}
	n := copy(p, r.buf[r.bufPos:])
	r.bufPos += n
	return n, nil
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, "Usage: mod_player <file.mod>\n")
		os.Exit(1)
	}

	filename := os.Args[1]
	mod, err := ParseMod(filename)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error parsing MOD: %v\n", err)
		os.Exit(1)
	}

	// Print file info.
	fmt.Printf("Title    : %s\n", mod.Title)
	fmt.Printf("Channels : %d\n", mod.NumChannels)
	fmt.Printf("Patterns : %d\n", len(mod.Patterns))
	fmt.Printf("Length   : %d\n", mod.SongLength)
	fmt.Println("Samples  :")
	for i := 1; i <= 31; i++ {
		s := mod.Samples[i]
		if s == nil || (s.Name == "" && s.Length == 0) {
			continue
		}
		fmt.Printf("  %2d: %-22s  len=%6d  vol=%2d  fine=%+d\n",
			i, s.Name, s.Length, s.Volume, s.Finetune)
	}
	fmt.Println()

	// Set up oto audio context.
	ctx, readyChan, err := oto.NewContext(&oto.NewContextOptions{
		SampleRate:   OUTPUT_RATE,
		ChannelCount: 2,
		Format:       oto.FormatFloat32LE,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "oto.NewContext: %v\n", err)
		os.Exit(1)
	}
	<-readyChan

	engine := NewModPlayer(mod)
	reader := &ModReader{player: engine}
	otoPlayer := ctx.NewPlayer(reader)
	otoPlayer.Play()

	// Signal handler for Ctrl+C.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	// Progress display loop.
	prevPos, prevRow := -1, -1
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-sigCh:
			fmt.Println()
			otoPlayer.Close()
			return
		case <-ticker.C:
			sp := engine.songPos
			rw := engine.row
			if sp != prevPos || rw != prevRow {
				prevPos = sp
				prevRow = rw
				fmt.Printf("\rPos %3d / %3d   Row %2d / 63   BPM %3d   Speed %d   ",
					sp, mod.SongLength-1, rw, engine.bpm, engine.speed)
			}
			if engine.Finished {
				fmt.Println()
				// Let the buffer drain before closing.
				time.Sleep(200 * time.Millisecond)
				otoPlayer.Close()
				return
			}
			if !otoPlayer.IsPlaying() && engine.Finished {
				fmt.Println()
				otoPlayer.Close()
				return
			}
		}
	}
}
