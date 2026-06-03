package main

import (
	"encoding/binary"
	"fmt"
	"os"
)

// SampleInfo holds metadata and audio data for one ProTracker sample slot.
type SampleInfo struct {
	Name      string
	Length    int   // in bytes
	Finetune  int8  // -8 to +7
	Volume    uint8 // 0–64
	LoopStart int   // in bytes
	LoopLen   int   // in bytes
	DataFloat []float32
}

func (s *SampleInfo) LoopEnd() int { return s.LoopStart + s.LoopLen }
func (s *SampleInfo) HasLoop() bool { return s.LoopLen > 2 }

// Note represents a single cell in a pattern.
type Note struct {
	SampleNum  int // 1–31 (0 = no sample)
	Period     int // 0 = no note
	EffectCmd  int // 0x0–0xF
	EffectData int // 0x00–0xFF
}

// Pattern holds 64 rows of per-channel notes.
type Pattern struct {
	Rows [][]Note // [64][numChannels]
}

// ModFile is the parsed representation of an Amiga MOD file.
type ModFile struct {
	Title        string
	NumChannels  int
	Samples      []*SampleInfo // index 0 is sentinel; samples are 1-indexed
	SongLength   int
	RestartPos   int
	PatternTable []int // 128 entries
	Patterns     []Pattern
}

// ParseMod reads and parses an Amiga ProTracker MOD file.
func ParseMod(filename string) (*ModFile, error) {
	data, err := os.ReadFile(filename)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", filename, err)
	}
	if len(data) < 1084 {
		return nil, fmt.Errorf("file too short to be a MOD")
	}

	title := cstring(data[0:20])

	// Parse 31 sample headers; slot 0 is a nil sentinel.
	samples := make([]*SampleInfo, 32)
	for i := 0; i < 31; i++ {
		off := 20 + i*30
		name := cstring(data[off : off+22])
		length := int(binary.BigEndian.Uint16(data[off+22:off+24])) * 2
		fineRaw := data[off+24] & 0x0F
		var finetune int8
		if fineRaw < 8 {
			finetune = int8(fineRaw)
		} else {
			finetune = int8(fineRaw) - 16
		}
		volume := data[off+25]
		if volume > 64 {
			volume = 64
		}
		loopStart := int(binary.BigEndian.Uint16(data[off+26:off+28])) * 2
		loopLen := int(binary.BigEndian.Uint16(data[off+28:off+30])) * 2
		samples[i+1] = &SampleInfo{
			Name:      name,
			Length:    length,
			Finetune:  finetune,
			Volume:    volume,
			LoopStart: loopStart,
			LoopLen:   loopLen,
		}
	}

	songLength := int(data[950])
	restartPos := int(data[951])
	patternTable := make([]int, 128)
	for i := 0; i < 128; i++ {
		patternTable[i] = int(data[952+i])
	}

	tag := string(data[1080:1084])
	var numChannels int
	switch tag {
	case "M.K.", "M!K!", "4CHN", "FLT4":
		numChannels = 4
	case "6CHN":
		numChannels = 6
	case "8CHN", "FLT8", "OCTA":
		numChannels = 8
	default:
		numChannels = 4
	}

	numPatterns := 0
	for i := 0; i < songLength; i++ {
		if patternTable[i]+1 > numPatterns {
			numPatterns = patternTable[i] + 1
		}
	}

	offset := 1084
	patterns := make([]Pattern, numPatterns)
	for p := 0; p < numPatterns; p++ {
		rows := make([][]Note, 64)
		for r := 0; r < 64; r++ {
			notes := make([]Note, numChannels)
			for c := 0; c < numChannels; c++ {
				if offset+4 > len(data) {
					return nil, fmt.Errorf("unexpected end of file reading patterns")
				}
				b := data[offset : offset+4]
				offset += 4
				sampleNum := int(b[0]&0xF0) | int(b[2]>>4)
				period := int(b[0]&0x0F)<<8 | int(b[1])
				effectCmd := int(b[2] & 0x0F)
				effectData := int(b[3])
				notes[c] = Note{
					SampleNum:  sampleNum,
					Period:     period,
					EffectCmd:  effectCmd,
					EffectData: effectData,
				}
			}
			rows[r] = notes
		}
		patterns[p] = Pattern{Rows: rows}
	}

	// Read sample audio data.
	for i := 1; i <= 31; i++ {
		s := samples[i]
		end := offset + s.Length
		if end > len(data) {
			end = len(data)
		}
		raw := data[offset:end]
		offset += s.Length

		s.DataFloat = make([]float32, s.Length)
		for j, b := range raw {
			s.DataFloat[j] = float32(int8(b)) / 128.0
		}
		// remaining bytes (if file was truncated) stay zero
	}

	return &ModFile{
		Title:        title,
		NumChannels:  numChannels,
		Samples:      samples,
		SongLength:   songLength,
		RestartPos:   restartPos,
		PatternTable: patternTable,
		Patterns:     patterns,
	}, nil
}

// cstring converts a null-padded byte slice to a Go string (latin-1 passthrough).
func cstring(b []byte) string {
	for i, c := range b {
		if c == 0 {
			return string(b[:i])
		}
	}
	return string(b)
}
