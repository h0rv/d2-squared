package engine

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

const historyLimit = 30

var (
	ErrStale   = errors.New("stale version")
	errNoUndo  = errors.New("nothing to undo")
	errNoRedo  = errors.New("nothing to redo")
	errNoLayer = errors.New("no layout yet")
)

type View struct {
	Version int64   `json:"version"`
	Source  string  `json:"source"`
	Error   string  `json:"error,omitempty"`
	Cause   string  `json:"cause"`
	Changed []int   `json:"changed"`
	CanUndo bool    `json:"canUndo"`
	CanRedo bool    `json:"canRedo"`
	MS      float64 `json:"ms"`
	*Layout
}

type Writer func(source string) error

type Session struct {
	write Writer
	seeds []int64
	mu    sync.Mutex
	view  View
	undo  []View
	redo  []View
	ver   int64
	wake  chan struct{}
	cache map[string]*Candidate
	order []string

	flight map[string]*flight
	urgent atomic.Int32
}

type flight struct {
	done chan struct{}
	c    *Candidate
	err  error
}

func NewSession(write Writer) *Session {
	return &Session{write: write, seeds: []int64{1}, wake: make(chan struct{}), cache: map[string]*Candidate{}, flight: map[string]*flight{}}
}

func sourceHash(source string) string {
	sum := sha1.Sum([]byte(source))
	return hex.EncodeToString(sum[:8])
}

func (s *Session) cacheGet(key string) *Candidate {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cache[key]
}

func (s *Session) cachePut(key string, c *Candidate) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.cache[key]; !ok {
		s.order = append(s.order, key)
	}
	s.cache[key] = c
	for len(s.order) > 96 {
		delete(s.cache, s.order[0])
		s.order = s.order[1:]
	}
}

func (s *Session) publish(v View, cause string, started time.Time) View {
	s.ver++
	v.Version = s.ver
	v.Cause = cause
	v.Changed = addedLines(s.view.Source, v.Source)
	if cause == "open" {
		v.Changed = []int{}
	}
	v.MS = float64(time.Since(started).Microseconds()) / 1000
	v.CanUndo = len(s.undo) > 0
	v.CanRedo = len(s.redo) > 0
	s.view = v
	close(s.wake)
	s.wake = make(chan struct{})
	return v
}

func (s *Session) writeSource(source string) error {
	if s.write == nil {
		return nil
	}
	return s.write(source)
}

func (s *Session) push(stack *[]View) {
	if s.view.Layout == nil {
		return
	}
	*stack = append(*stack, s.view)
	if len(*stack) > historyLimit {
		*stack = (*stack)[1:]
	}
}

func (s *Session) Open(source string) (View, error) {
	started := time.Now()
	layout, err := layoutWith(context.Background(), source, engineLayout(s.seeds))
	if err != nil {
		return View{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.undo, s.redo = nil, nil
	layout.userSized = sizedIn(source)
	return s.publish(View{Source: source, Layout: layout}, "open", started), nil
}

func (s *Session) Reload(source string) (View, error) {
	started := time.Now()
	layout, err := layoutWith(context.Background(), source, engineLayout(s.seeds))
	s.mu.Lock()
	defer s.mu.Unlock()
	if err != nil {
		v := s.view
		v.Error = err.Error()
		return s.publish(v, "error", started), err
	}
	s.push(&s.undo)
	s.redo = nil
	layout.userSized = sizedIn(source)
	return s.publish(View{Source: source, Layout: layout}, "reload", started), nil
}

func (s *Session) Snapshot() View {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.view
}

func (s *Session) Wait(ctx context.Context, since int64) View {
	for {
		s.mu.Lock()
		v, wake := s.view, s.wake
		s.mu.Unlock()
		if v.Version > since {
			return v
		}
		select {
		case <-wake:
		case <-ctx.Done():
			return v
		case <-time.After(20 * time.Second):
			return v
		}
	}
}

func (s *Session) build(ctx context.Context, v View, e Edit) (*Candidate, error) {
	key := sourceHash(v.Source) + "|" + e.ID()
	for {
		if c := s.cacheGet(key); c != nil {
			hit := *c
			hit.Cached = true
			return &hit, nil
		}
		s.mu.Lock()
		f, running := s.flight[key]
		if !running {
			f = &flight{done: make(chan struct{})}
			s.flight[key] = f
		}
		s.mu.Unlock()
		if running {
			select {
			case <-f.done:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			if f.err == nil {
				hit := *f.c
				hit.Cached = true
				return &hit, nil
			}
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			continue
		}
		f.c, f.err = s.compute(ctx, v, e, key)
		s.mu.Lock()
		delete(s.flight, key)
		s.mu.Unlock()
		close(f.done)
		return f.c, f.err
	}
}

func (s *Session) compute(ctx context.Context, v View, e Edit, key string) (*Candidate, error) {
	b, ok := registry[e.Kind]
	if !ok {
		return nil, fmt.Errorf("unknown edit %q", e.Kind)
	}
	started := time.Now()
	c, err := b.Build(ctx, v.Layout, v.Source, e)
	if err != nil {
		return nil, err
	}
	sized := remapSized(v.Layout.userSized, e)
	if c.layout.tala() {
		if err := c.hugGroups(ctx, sized); err != nil {
			return nil, err
		}
	}
	c.layout.userSized = sized
	c.Key = e.ID()
	c.MS = float64(time.Since(started).Microseconds()) / 1000
	s.cachePut(key, c)
	return c, nil
}

func (s *Session) Candidate(ctx context.Context, e Edit, version int64) (*Candidate, error) {
	v := s.Snapshot()
	if v.Layout == nil {
		return nil, errNoLayer
	}
	if version != 0 && version != v.Version {
		return nil, ErrStale
	}
	return s.build(ctx, v, e)
}

func (s *Session) Plan(t Target, p Point, version int64) ([]Edit, error) {
	v := s.Snapshot()
	if v.Layout == nil {
		return nil, errNoLayer
	}
	if version != 0 && version != v.Version {
		return nil, ErrStale
	}
	edits := []Edit{}
	for _, b := range behaviorOrder {
		if hasTarget(b, v.Layout, t) {
			edits = append(edits, b.Candidates(v.Layout, t, p)...)
		}
	}
	return edits, nil
}

func (s *Session) Preview(ctx context.Context, t Target, p Point, version int64) (<-chan *Candidate, error) {
	edits, err := s.Plan(t, p, version)
	if err != nil {
		return nil, err
	}
	v := s.Snapshot()
	out := make(chan *Candidate, len(edits))
	slots := make(chan struct{}, max(runtime.GOMAXPROCS(0)-2, 1))
	var wg sync.WaitGroup
	for _, e := range edits {
		for s.urgent.Load() > 0 && ctx.Err() == nil {
			time.Sleep(5 * time.Millisecond)
		}
		select {
		case slots <- struct{}{}:
		case <-ctx.Done():
		}
		if ctx.Err() != nil {
			break
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-slots }()
			if c, err := s.build(ctx, v, e); err == nil {
				out <- c
			}
		}()
	}
	go func() {
		wg.Wait()
		close(out)
	}()
	return out, nil
}

func (s *Session) Route(t Target, delta Point, version int64) ([]Path, error) {
	v := s.Snapshot()
	if v.Layout == nil || (version != 0 && version != v.Version) {
		return nil, ErrStale
	}
	if t.Kind != "node" || !v.Layout.tala() {
		return []Path{}, nil
	}
	return v.Layout.reroute(t.ID, delta.X, delta.Y)
}

func (s *Session) Commit(ctx context.Context, e Edit, version int64) (string, View, error) {
	started := time.Now()
	v := s.Snapshot()
	if v.Layout == nil {
		return "", View{}, errNoLayer
	}
	if version != 0 && version != v.Version {
		return "", View{}, ErrStale
	}
	s.urgent.Add(1)
	c, err := s.build(ctx, v, e)
	s.urgent.Add(-1)
	if err != nil {
		return "", View{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.view.Version != v.Version {
		return "", View{}, ErrStale
	}
	if err := s.writeSource(c.source); err != nil {
		return "", View{}, err
	}
	s.push(&s.undo)
	s.redo = nil
	return c.source, s.publish(View{Source: c.source, Layout: c.layout}, "commit", started), nil
}

func (s *Session) step(from, to *[]View, cause string, none error) (View, error) {
	started := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(*from) == 0 {
		return s.view, none
	}
	prev := (*from)[len(*from)-1]
	*from = (*from)[:len(*from)-1]
	s.push(to)
	if err := s.writeSource(prev.Source); err != nil {
		return s.view, err
	}
	return s.publish(View{Source: prev.Source, Layout: prev.Layout}, cause, started), nil
}

func (s *Session) Undo() (View, error) { return s.step(&s.undo, &s.redo, "undo", errNoUndo) }

func (s *Session) Redo() (View, error) { return s.step(&s.redo, &s.undo, "redo", errNoRedo) }

type Drift struct {
	MaxDelta float64 `json:"maxDelta"`
	Moved    int     `json:"moved"`
	Shapes   int     `json:"shapes"`
}

func (s *Session) Verify(ctx context.Context) (Drift, error) {
	v := s.Snapshot()
	if v.Layout == nil {
		return Drift{}, errNoLayer
	}
	fresh, err := layoutWith(ctx, v.Source, engineLayout(s.seeds))
	if err != nil {
		return Drift{}, err
	}
	d := Drift{Shapes: len(fresh.Shapes)}
	now := v.Layout.shapeMap()
	for _, sh := range fresh.Shapes {
		if o, ok := now[sh.ID]; ok {
			delta := math.Hypot(float64(o.X-sh.X), float64(o.Y-sh.Y))
			d.MaxDelta = math.Max(d.MaxDelta, delta)
			if delta > 1 {
				d.Moved++
			}
		}
	}
	return d, nil
}
