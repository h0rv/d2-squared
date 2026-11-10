package main

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/h0rv/d2-squared/engine"
)

type server struct {
	session *engine.Session
	file    string
	mu      sync.Mutex
	mod     time.Time
}

func newServer(path string) (*server, engine.View, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, engine.View{}, err
	}
	s := &server{file: path}
	s.session = engine.NewSession(s.write)
	v, err := s.session.Open(string(raw))
	if err != nil {
		return nil, engine.View{}, err
	}
	s.remember()
	return s, v, nil
}

func (s *server) write(source string) error {
	if err := os.WriteFile(s.file, []byte(source), 0o644); err != nil {
		return err
	}
	s.remember()
	return nil
}

func (s *server) remember() {
	if info, err := os.Stat(s.file); err == nil {
		s.mu.Lock()
		s.mod = info.ModTime()
		s.mu.Unlock()
	}
}

func (s *server) poll() error {
	info, err := os.Stat(s.file)
	if err != nil {
		return err
	}
	s.mu.Lock()
	same := info.ModTime().Equal(s.mod)
	s.mu.Unlock()
	if same {
		return nil
	}
	raw, err := os.ReadFile(s.file)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.mod = info.ModTime()
	s.mu.Unlock()
	if string(raw) == s.session.Snapshot().Source {
		return nil
	}
	_, err = s.session.Reload(string(raw))
	return err
}

func (s *server) watch() {
	for range time.Tick(250 * time.Millisecond) {
		if err := s.poll(); err != nil {
			log.Print("reload: ", err)
		}
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Print(err)
	}
}

func fail(w http.ResponseWriter, err error) {
	code := http.StatusUnprocessableEntity
	if errors.Is(err, engine.ErrStale) {
		code = http.StatusConflict
	}
	http.Error(w, err.Error(), code)
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return false
	}
	return true
}

func (s *server) info(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, map[string]string{"mode": "serve", "file": filepath.Base(s.file)})
}

func (s *server) catalog(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, engine.Describe())
}

func (s *server) view(w http.ResponseWriter, r *http.Request) {
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	v := s.session.Snapshot()
	if r.URL.Query().Get("wait") != "" {
		v = s.session.Wait(r.Context(), since)
	}
	if v.Version <= since {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, v)
}

type previewReq struct {
	Target  engine.Target `json:"target"`
	At      engine.Point  `json:"at"`
	Version int64         `json:"version"`
}

func (s *server) preview(w http.ResponseWriter, r *http.Request) {
	var req previewReq
	if !decode(w, r, &req) {
		return
	}
	started := time.Now()
	ch, err := s.session.Preview(r.Context(), req.Target, req.At, req.Version)
	if err != nil {
		fail(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/x-ndjson")
	flusher, _ := w.(http.Flusher)
	enc := json.NewEncoder(w)
	n := 0
	for c := range ch {
		n++
		_ = enc.Encode(map[string]any{"candidate": c})
		if flusher != nil {
			flusher.Flush()
		}
	}
	_ = enc.Encode(map[string]any{"done": true, "count": n, "ms": float64(time.Since(started).Microseconds()) / 1000})
}

type editReq struct {
	Edit    engine.Edit `json:"edit"`
	Version int64       `json:"version"`
}

func (s *server) candidate(w http.ResponseWriter, r *http.Request) {
	var req editReq
	if !decode(w, r, &req) {
		return
	}
	c, err := s.session.Candidate(r.Context(), req.Edit, req.Version)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, c)
}

func (s *server) commit(w http.ResponseWriter, r *http.Request) {
	var req editReq
	if !decode(w, r, &req) {
		return
	}
	_, v, err := s.session.Commit(r.Context(), req.Edit, req.Version)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, v)
}

type routeReq struct {
	Target  engine.Target `json:"target"`
	Delta   engine.Point  `json:"delta"`
	Version int64         `json:"version"`
}

func (s *server) route(w http.ResponseWriter, r *http.Request) {
	var req routeReq
	if !decode(w, r, &req) {
		return
	}
	started := time.Now()
	paths, err := s.session.Route(req.Target, req.Delta, req.Version)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, map[string]any{"paths": paths, "ms": float64(time.Since(started).Microseconds()) / 1000})
}

func (s *server) history(redo bool) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		step := s.session.Undo
		if redo {
			step = s.session.Redo
		}
		v, err := step()
		if err != nil {
			fail(w, err)
			return
		}
		writeJSON(w, v)
	}
}

func (s *server) verify(w http.ResponseWriter, r *http.Request) {
	d, err := s.session.Verify(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, d)
}

func (s *server) text(w http.ResponseWriter, r *http.Request) {
	res, err := s.session.Text(r.Context(), r.URL.Query().Get("charset") != "ascii")
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, res)
}

func (s *server) exportSVG(w http.ResponseWriter, r *http.Request) {
	svg, err := s.session.ExportSVG(r.Context(), r.URL.Query().Get("dark") != "")
	if err != nil {
		fail(w, err)
		return
	}
	w.Header().Set("Content-Type", "image/svg+xml")
	_, _ = w.Write(svg)
}

func (s *server) routes(ui fs.FS) *http.ServeMux {
	mux := http.NewServeMux()
	mux.Handle("GET /", http.FileServerFS(ui))
	mux.HandleFunc("GET /api/info", s.info)
	mux.HandleFunc("GET /api/catalog", s.catalog)
	mux.HandleFunc("GET /api/view", s.view)
	mux.HandleFunc("POST /api/preview", s.preview)
	mux.HandleFunc("POST /api/candidate", s.candidate)
	mux.HandleFunc("POST /api/commit", s.commit)
	mux.HandleFunc("POST /api/route", s.route)
	mux.HandleFunc("POST /api/undo", s.history(false))
	mux.HandleFunc("POST /api/redo", s.history(true))
	mux.HandleFunc("GET /api/verify", s.verify)
	mux.HandleFunc("GET /api/text", s.text)
	mux.HandleFunc("GET /api/export/svg", s.exportSVG)
	return mux
}
