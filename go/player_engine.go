package main

import (
	"math"
)

const (
	OUTPUT_RATE  = 44100
	PAULA_CLOCK  = 7093789.2 // PAL Amiga
)

var sineTable [64]int32

func init() {
	for i := 0; i < 64; i++ {
		sineTable[i] = int32(math.Round(255 * math.Sin(math.Pi*2*float64(i)/64)))
	}
}

func waveValue(pos, waveform int) int32 {
	pos = pos & 63
	switch waveform & 3 {
	case 0:
		return sineTable[pos]
	case 1:
		return 255 - int32(pos)*8
	default:
		if pos < 32 {
			return 255
		}
		return -255
	}
}

// Channel holds the playback state for one MOD channel.
type Channel struct {
	sample          *SampleInfo
	pos             float64
	period          int
	effectivePeriod int
	volume          int
	effectiveVolume int
	effectCmd       int
	effectData      int
	portTarget      int
	portSpeed       int
	vibSpeed        int
	vibDepth        int
	vibPos          int
	vibWaveform     int
	tremSpeed       int
	tremDepth       int
	tremPos         int
	tremWaveform    int
	arpBasePeriod   int
	loopRow         int
	loopCount       int
	noteDelay       int
	delayedNote     *Note
	noteCutTick     int
	retrigCount     int
}

// ModPlayer is the tick-based ProTracker playback engine.
type ModPlayer struct {
	mod             *ModFile
	channels        []*Channel
	songPos         int
	row             int
	tick            int
	speed           int
	bpm             int
	samplesPerTick  int
	tickSamplePos   int
	jumpFlag        bool
	jumpPos         int
	breakRow        int
	patternDelay    int
	pan             []int // 0=left 1=right per channel
	Finished        bool
}

// NewModPlayer creates and initialises a ModPlayer.
func NewModPlayer(mod *ModFile) *ModPlayer {
	p := &ModPlayer{
		mod:      mod,
		speed:    6,
		bpm:      125,
		jumpPos:  -1,
		breakRow: -1,
	}
	p.samplesPerTick = p.calcSPT(125)
	p.channels = make([]*Channel, mod.NumChannels)
	for i := range p.channels {
		p.channels[i] = &Channel{noteCutTick: -1}
	}
	// Amiga hard-pan: L R R L (repeating for >4 channels)
	p.pan = make([]int, mod.NumChannels)
	basePan := []int{0, 1, 1, 0}
	for i := 0; i < mod.NumChannels; i++ {
		p.pan[i] = basePan[i%4]
	}
	p.processRow()
	p.tick = 1
	return p
}

// Render produces nFrames stereo samples as interleaved float32 (L,R,L,R,...).
func (p *ModPlayer) Render(nFrames int) []float32 {
	output := make([]float32, nFrames*2)
	done := 0
	for done < nFrames {
		remaining := p.samplesPerTick - p.tickSamplePos
		toRender := nFrames - done
		if toRender > remaining {
			toRender = remaining
		}
		for chIdx, ch := range p.channels {
			samples := p.renderChannel(ch, toRender)
			col := p.pan[chIdx]
			for i, s := range samples {
				output[(done+i)*2+col] += s
			}
		}
		done += toRender
		p.tickSamplePos += toRender
		if p.tickSamplePos >= p.samplesPerTick {
			p.tickSamplePos = 0
			p.advanceTick()
		}
	}
	// Clip to [-1, 1]
	for i, v := range output {
		if v > 1.0 {
			output[i] = 1.0
		} else if v < -1.0 {
			output[i] = -1.0
		}
	}
	return output
}

func (p *ModPlayer) calcSPT(bpm int) int {
	v := int(math.Round(float64(OUTPUT_RATE) * 2.5 / float64(bpm)))
	if v < 1 {
		return 1
	}
	return v
}

func (p *ModPlayer) advanceTick() {
	effectiveSpeed := p.speed * (1 + p.patternDelay)
	if p.tick == 0 {
		p.processRow()
	} else {
		tickInSpeed := p.tick % p.speed
		p.processTickEffects(tickInSpeed)
	}
	p.tick++
	if p.tick >= effectiveSpeed {
		p.tick = 0
		p.patternDelay = 0
		p.advancePosition()
	}
}

func (p *ModPlayer) advancePosition() {
	if p.jumpFlag {
		p.jumpFlag = false
		nextPos := p.songPos + 1
		if p.jumpPos >= 0 {
			nextPos = p.jumpPos
		}
		nextRow := 0
		if p.breakRow >= 0 {
			nextRow = p.breakRow
		}
		p.jumpPos = -1
		p.breakRow = -1
		p.songPos = nextPos % p.mod.SongLength
		p.row = nextRow
	} else {
		p.row++
		if p.row >= 64 {
			p.row = 0
			p.songPos++
			if p.songPos >= p.mod.SongLength {
				p.songPos = p.mod.RestartPos % p.mod.SongLength
				p.Finished = true
			}
		}
	}
}

func (p *ModPlayer) processRow() {
	patIdx := p.mod.PatternTable[p.songPos]
	pattern := p.mod.Patterns[patIdx]
	notes := pattern.Rows[p.row]
	for i, ch := range p.channels {
		note := notes[i]
		ch.noteCutTick = -1
		ch.noteDelay = 0
		ch.delayedNote = nil
		ch.effectCmd = note.EffectCmd
		ch.effectData = note.EffectData

		isNoteDelay := note.EffectCmd == 0xE &&
			(note.EffectData>>4) == 0xD &&
			(note.EffectData&0xF) > 0

		if isNoteDelay {
			ch.noteDelay = note.EffectData & 0xF
			n := note // copy
			ch.delayedNote = &n
		} else {
			if note.Period > 0 || note.SampleNum > 0 {
				p.triggerNote(ch, &note)
			}
		}
		p.processTick0Effect(ch, &note)
		if note.EffectCmd != 0x4 && note.EffectCmd != 0x6 && note.EffectCmd != 0x7 {
			ch.effectivePeriod = ch.period
		}
		if note.EffectCmd != 0x7 {
			ch.effectiveVolume = ch.volume
		}
	}
}

func (p *ModPlayer) triggerNote(ch *Channel, note *Note) {
	if note.SampleNum > 0 {
		s := p.mod.Samples[note.SampleNum]
		if s != nil && s.Length > 0 {
			ch.sample = s
			ch.volume = int(s.Volume)
			ch.effectiveVolume = ch.volume
		}
	}
	if note.Period > 0 {
		if note.EffectCmd == 0x3 || note.EffectCmd == 0x5 {
			ch.portTarget = note.Period
			if note.EffectCmd == 0x3 && note.EffectData != 0 {
				ch.portSpeed = note.EffectData
			}
		} else {
			ft := 0
			if ch.sample != nil {
				ft = int(ch.sample.Finetune)
			}
			if ft != 0 {
				ch.period = int(math.Round(float64(note.Period) * math.Pow(2, float64(-ft)/96.0)))
				if ch.period < 1 {
					ch.period = 1
				}
			} else {
				ch.period = note.Period
			}
			ch.effectivePeriod = ch.period
			ch.pos = 0.0
			ch.arpBasePeriod = ch.period
			if ch.vibWaveform < 4 {
				ch.vibPos = 0
			}
			if ch.tremWaveform < 4 {
				ch.tremPos = 0
			}
		}
	}
}

func (p *ModPlayer) processTick0Effect(ch *Channel, note *Note) {
	cmd := note.EffectCmd
	data := note.EffectData
	x := (data >> 4) & 0xF
	y := data & 0xF

	switch cmd {
	case 0x4:
		if x != 0 {
			ch.vibSpeed = x
		}
		if y != 0 {
			ch.vibDepth = y
		}
	case 0x7:
		if x != 0 {
			ch.tremSpeed = x
		}
		if y != 0 {
			ch.tremDepth = y
		}
	case 0x9:
		ch.pos = float64(data * 256)
	case 0xB:
		p.jumpPos = data
		p.jumpFlag = true
	case 0xC:
		if data > 64 {
			data = 64
		}
		ch.volume = data
		ch.effectiveVolume = ch.volume
	case 0xD:
		p.breakRow = x*10 + y
		if p.jumpPos < 0 {
			p.jumpPos = p.songPos + 1
		}
		p.jumpFlag = true
	case 0xF:
		if data < 0x20 {
			if data < 1 {
				data = 1
			}
			p.speed = data
		} else {
			p.bpm = data
			p.samplesPerTick = p.calcSPT(data)
		}
	case 0xE:
		sub := x
		val := y
		switch sub {
		case 0x1:
			ch.period -= val
			if ch.period < 1 {
				ch.period = 1
			}
		case 0x2:
			ch.period += val
			if ch.period > 0xFFF {
				ch.period = 0xFFF
			}
		case 0x4:
			ch.vibWaveform = val
		case 0x5:
			ch.loopRow = p.row
			ch.loopCount = 0
		case 0x6:
			if val == 0 {
				ch.loopRow = p.row
				ch.loopCount = 0
			} else if ch.loopCount == 0 {
				ch.loopCount = val
				p.breakRow = ch.loopRow
				p.jumpPos = p.songPos
				p.jumpFlag = true
			} else {
				ch.loopCount--
				if ch.loopCount > 0 {
					p.breakRow = ch.loopRow
					p.jumpPos = p.songPos
					p.jumpFlag = true
				}
			}
		case 0x7:
			ch.tremWaveform = val
		case 0x9:
			ch.retrigCount = val
		case 0xA:
			ch.volume += val
			if ch.volume > 64 {
				ch.volume = 64
			}
			ch.effectiveVolume = ch.volume
		case 0xB:
			ch.volume -= val
			if ch.volume < 0 {
				ch.volume = 0
			}
			ch.effectiveVolume = ch.volume
		case 0xC:
			ch.noteCutTick = val
		case 0xE:
			p.patternDelay = val
		}
	}
}

func (p *ModPlayer) processTickEffects(tickInSpeed int) {
	for _, ch := range p.channels {
		p.processChannelTick(ch, tickInSpeed)
	}
}

func (p *ModPlayer) processChannelTick(ch *Channel, tick int) {
	cmd := ch.effectCmd
	data := ch.effectData
	x := (data >> 4) & 0xF
	y := data & 0xF

	if ch.noteCutTick >= 0 && tick == ch.noteCutTick {
		ch.volume = 0
		ch.effectiveVolume = 0
	}
	if ch.noteDelay > 0 && tick == ch.noteDelay && ch.delayedNote != nil {
		p.triggerNote(ch, ch.delayedNote)
		ch.effectivePeriod = ch.period
		ch.effectiveVolume = ch.volume
		p.processTick0Effect(ch, ch.delayedNote)
		ch.delayedNote = nil
		ch.noteDelay = 0
	}

	switch cmd {
	case 0x0:
		if data != 0 {
			phase := tick % 3
			switch phase {
			case 0:
				ch.effectivePeriod = ch.arpBasePeriod
			case 1:
				v := int(math.Round(float64(ch.arpBasePeriod) / math.Pow(2, float64(x)/12.0)))
				if v < 1 {
					v = 1
				}
				ch.effectivePeriod = v
			case 2:
				v := int(math.Round(float64(ch.arpBasePeriod) / math.Pow(2, float64(y)/12.0)))
				if v < 1 {
					v = 1
				}
				ch.effectivePeriod = v
			}
		}
	case 0x1:
		ch.period -= data
		if ch.period < 1 {
			ch.period = 1
		}
		ch.effectivePeriod = ch.period
	case 0x2:
		ch.period += data
		if ch.period > 0xFFF {
			ch.period = 0xFFF
		}
		ch.effectivePeriod = ch.period
	case 0x3:
		if ch.portTarget != 0 && ch.period != 0 {
			if ch.period < ch.portTarget {
				ch.period += ch.portSpeed
				if ch.period > ch.portTarget {
					ch.period = ch.portTarget
				}
			} else {
				ch.period -= ch.portSpeed
				if ch.period < ch.portTarget {
					ch.period = ch.portTarget
				}
			}
		}
		ch.effectivePeriod = ch.period
	case 0x4:
		ch.vibPos = (ch.vibPos + ch.vibSpeed) & 63
		delta := int(waveValue(ch.vibPos, ch.vibWaveform)) * ch.vibDepth >> 7
		ep := ch.period + delta
		if ep < 1 {
			ep = 1
		}
		ch.effectivePeriod = ep
	case 0x5:
		if ch.portTarget != 0 && ch.period != 0 {
			if ch.period < ch.portTarget {
				ch.period += ch.portSpeed
				if ch.period > ch.portTarget {
					ch.period = ch.portTarget
				}
			} else {
				ch.period -= ch.portSpeed
				if ch.period < ch.portTarget {
					ch.period = ch.portTarget
				}
			}
		}
		ch.effectivePeriod = ch.period
		p.doVolumeSlide(ch, data)
	case 0x6:
		ch.vibPos = (ch.vibPos + ch.vibSpeed) & 63
		delta := int(waveValue(ch.vibPos, ch.vibWaveform)) * ch.vibDepth >> 7
		ep := ch.period + delta
		if ep < 1 {
			ep = 1
		}
		ch.effectivePeriod = ep
		p.doVolumeSlide(ch, data)
	case 0x7:
		ch.tremPos = (ch.tremPos + ch.tremSpeed) & 63
		delta := int(waveValue(ch.tremPos, ch.tremWaveform)) * ch.tremDepth >> 6
		ev := ch.volume + delta
		if ev < 0 {
			ev = 0
		} else if ev > 64 {
			ev = 64
		}
		ch.effectiveVolume = ev
	case 0xA:
		p.doVolumeSlide(ch, data)
	case 0xE:
		if x == 0x9 && ch.retrigCount > 0 {
			if tick%ch.retrigCount == 0 {
				ch.pos = 0.0
			}
		}
	}
}

func (p *ModPlayer) doVolumeSlide(ch *Channel, data int) {
	x := (data >> 4) & 0xF
	y := data & 0xF
	if x != 0 {
		ch.volume += x
		if ch.volume > 64 {
			ch.volume = 64
		}
	} else if y != 0 {
		ch.volume -= y
		if ch.volume < 0 {
			ch.volume = 0
		}
	}
	ch.effectiveVolume = ch.volume
}

func (p *ModPlayer) renderChannel(ch *Channel, n int) []float32 {
	out := make([]float32, n)
	if ch.sample == nil || ch.effectivePeriod == 0 || len(ch.sample.DataFloat) == 0 {
		return out
	}
	data := ch.sample.DataFloat
	slen := len(data)
	rate := PAULA_CLOCK / (float64(ch.effectivePeriod) * 2.0 * OUTPUT_RATE)
	volume := float32(ch.effectiveVolume) / 64.0
	hasLoop := ch.sample.HasLoop()
	loopStart := ch.sample.LoopStart
	loopEnd := ch.sample.LoopEnd()
	if loopEnd > slen {
		loopEnd = slen
	}
	loopLen := 0
	if hasLoop && loopEnd > loopStart {
		loopLen = loopEnd - loopStart
	}
	pos := ch.pos
	for i := 0; i < n; i++ {
		ipos := int(pos)
		if ipos >= slen {
			break
		}
		out[i] = data[ipos] * volume
		pos += rate
		if hasLoop && loopLen > 0 && pos >= float64(loopEnd) {
			pos -= float64(loopLen)
		}
	}
	ch.pos = pos
	return out
}
