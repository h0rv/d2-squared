package engine

import (
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

var allEngines = []string{engineTala, engineELK, engineDagre}

var exampleLabels = map[string]string{
	"architecture.d2": "Postgres",
	"erd.d2":          "customers",
	"family.d2":       "Rose and Leo",
	"order-states.d2": "Placed",
	"org.d2":          "Engineer",
}

func examples(t *testing.T) []string {
	t.Helper()
	files, err := filepath.Glob("../examples/*.d2")
	if err != nil || len(files) != len(exampleLabels) {
		t.Fatalf("%v %v", files, err)
	}
	return files
}

func withEngine(t *testing.T, path, engine string) *harness {
	t.Helper()
	h := newHarness(t, path)
	if engine != engineTala {
		h.mustCommit(Edit{Kind: "config", Key: "layout-engine", To: engine})
	}
	if got := h.view().Config.Engine; got != engine {
		t.Fatalf("engine = %s, want %s", got, engine)
	}
	return h
}

func TestEveryEngineLaysOutEveryExample(t *testing.T) {
	for _, f := range examples(t) {
		want := len(newHarness(t, f).view().Shapes)
		for _, engine := range allEngines {
			t.Run(filepath.Base(f)+"/"+engine, func(t *testing.T) {
				h := withEngine(t, f, engine)
				v := h.view()
				if len(v.Shapes) != want || len(v.Scene.Shapes) != want || len(v.Conns) != len(v.Scene.Conns) {
					t.Fatalf("shapes = %d, want %d", len(v.Shapes), want)
				}
				for _, c := range v.Conns {
					if len(c.Route) < 2 {
						t.Fatalf("connection %s has no route", c.ID)
					}
				}
				hasNull(t, "view", v)
			})
		}
	}
}

func TestReparentCommitWithOtherEngines(t *testing.T) {
	for _, engine := range []string{engineELK, engineDagre} {
		t.Run(engine, func(t *testing.T) {
			h := withEngine(t, "testdata/arch.d2", engine)
			before := strings.Count(h.src, "left:")
			h.mustCommit(Edit{Kind: "move", Key: "services.billing", To: "data"})
			if !regexp.MustCompile(`(?ms)^data: \{.*billing: Billing Service.*?^\}`).MatchString(h.src) {
				t.Fatalf("billing is not inside data:\n%s", h.src)
			}
			if strings.Count(h.src, "left:") != before {
				t.Fatalf("a layout without positions should not save any:\n%s", h.src)
			}
			s := h.shapes()["data.billing"]
			d := h.shapes()["data"]
			if s.X < d.X || s.Y < d.Y || s.X+s.Width > d.X+d.Width || s.Y+s.Height > d.Y+d.Height {
				t.Fatalf("billing %+v is outside data %+v", s, d)
			}
			h.mustCommit(Edit{Kind: "move", Key: "data.billing", To: ""})
			if !regexp.MustCompile(`(?m)^billing: `).MatchString(h.src) {
				t.Fatalf("billing is not at the top level:\n%s", h.src)
			}
		})
	}
}

func TestPreviewCandidatesWithOtherEngines(t *testing.T) {
	for _, engine := range allEngines {
		t.Run(engine, func(t *testing.T) {
			h := withEngine(t, "testdata/arch.d2", engine)
			v := h.view()
			ch, err := h.session.Preview(h.ctx(), Target{Kind: "node", ID: "services.billing"}, Point{X: 600, Y: 1200}, v.Version)
			if err != nil {
				t.Fatal(err)
			}
			n, slowest := 0, 0.0
			for c := range ch {
				n++
				slowest = max(slowest, c.MS)
				if c.Landing.Width == 0 {
					t.Fatalf("candidate %s has no landing", c.Key)
				}
			}
			if n == 0 {
				t.Fatal("expected preview candidates")
			}
			t.Logf("%s: %d candidates, slowest %.0f ms", engine, n, slowest)
		})
	}
}

func TestReconnectWithOtherEngines(t *testing.T) {
	for _, engine := range []string{engineELK, engineDagre} {
		t.Run(engine, func(t *testing.T) {
			h := withEngine(t, "testdata/arch.d2", engine)
			edge := h.edgeID("services.billing", "data.pg")
			v := h.mustCommit(Edit{Kind: "reconnect", Key: edge, End: "dst", To: "data.redis"})
			found := false
			for _, c := range v.Conns {
				found = found || (c.Src == "services.billing" && c.Dst == "data.redis")
			}
			if !found {
				t.Fatalf("the arrow was not reconnected:\n%s", h.src)
			}
			c, err := h.session.Candidate(h.ctx(), Edit{Kind: "reconnect", Key: h.edgeID("services.billing", "data.redis"), End: "dst", To: "data.pg"}, h.view().Version)
			if err != nil || len(c.Route) < 2 {
				t.Fatalf("candidate route: %v %v", c, err)
			}
		})
	}
}

func TestDirectionAndTidyWithOtherEngines(t *testing.T) {
	for _, engine := range []string{engineELK, engineDagre} {
		t.Run(engine, func(t *testing.T) {
			h := withEngine(t, "testdata/arch.d2", engine)
			h.mustCommit(Edit{Kind: "direction", Key: "", To: "down"})
			if !strings.Contains(h.src, "direction: down") {
				t.Fatalf("direction not saved:\n%s", h.src)
			}
			h.mustCommit(Edit{Kind: "tidy", Key: "data"})
		})
	}
}

func TestPlacingAndResizingNeedTala(t *testing.T) {
	for _, engine := range []string{engineELK, engineDagre} {
		t.Run(engine, func(t *testing.T) {
			h := withEngine(t, "testdata/arch.d2", engine)
			for _, e := range []Edit{{Kind: "pin", Key: "idp", Left: 10, Top: 10}, {Kind: "resize", Key: "idp", Left: 10, Top: 10, Width: 100, Height: 60}} {
				if _, err := h.commit(e); err == nil || !strings.Contains(err.Error(), "TALA") {
					t.Fatalf("%s should need TALA, got %v", e.Kind, err)
				}
			}
		})
	}
}

func TestLiveRoutesAreTalaOnly(t *testing.T) {
	h := withEngine(t, "testdata/arch.d2", engineELK)
	paths, err := h.session.Route(Target{Kind: "node", ID: "services.billing"}, Point{X: 40, Y: 40}, h.view().Version)
	if err != nil || paths == nil || len(paths) != 0 {
		t.Fatalf("paths = %v, err = %v", paths, err)
	}
	hasNull(t, "route", map[string]any{"paths": paths})
}

func TestSwitchingEnginesKeepsPositions(t *testing.T) {
	h := newHarness(t, "testdata/arch.d2")
	h.mustCommit(Edit{Kind: "move", Key: "services.billing", To: "data"})
	placed := h.shapes()["idp"]
	if !placed.Pinned || !strings.Contains(h.src, "left:") {
		t.Fatal("expected positions in the file")
	}
	pins := strings.Count(h.src, "left:")
	h.mustCommit(Edit{Kind: "config", Key: "layout-engine", To: engineELK})
	if strings.Count(h.src, "left:") != pins {
		t.Fatal("switching to ELK removed the positions")
	}
	for id, s := range h.shapes() {
		if s.Pinned {
			t.Fatalf("%s is pinned under ELK", id)
		}
	}
	h.mustCommit(Edit{Kind: "config", Key: "layout-engine", To: engineTala})
	back := h.shapes()["idp"]
	if !back.Pinned || back.X != placed.X || back.Y != placed.Y {
		t.Fatalf("idp = %+v, want %+v", back, placed)
	}
	if _, err := h.session.Undo(); err != nil {
		t.Fatal(err)
	}
	if h.view().Config.Engine != engineELK || !strings.Contains(h.src, "layout-engine: elk") {
		t.Fatal("undo should go back to ELK")
	}
}

func TestConfigWrites(t *testing.T) {
	cases := []struct {
		name, source, key, value, want string
	}{
		{"adds a config block", "a -> b\n", "layout-engine", "elk", "vars: {d2-config: {layout-engine: elk}}"},
		{"adds config to vars", "vars: {\n  x: 1\n}\na -> b\n", "sketch", "true", "sketch: true"},
		{"adds a key", "vars: {d2-config: {layout-engine: tala}}\na -> b\n", "theme-id", "4", "theme-id: 4"},
		{"replaces a key", "vars: {d2-config: {layout-engine: tala}}\na -> b\n", "layout-engine", "dagre", "layout-engine: dagre"},
		{"sets a dark theme", "a -> b\n", "dark-theme-id", "201", "dark-theme-id: 201"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out, err := setConfig(c.source, c.key, c.value)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out, c.want) {
				t.Fatalf("missing %q in:\n%s", c.want, out)
			}
			if strings.Count(out, c.key+":") != 1 || !strings.Contains(out, "a -> b") {
				t.Fatalf("unexpected output:\n%s", out)
			}
			cfg, err := readConfig(out)
			if err != nil {
				t.Fatal(err)
			}
			switch c.key {
			case "layout-engine":
				if cfg.Engine != c.value {
					t.Fatalf("%+v", cfg)
				}
			case "sketch":
				if !cfg.Sketch {
					t.Fatalf("%+v", cfg)
				}
			case "theme-id":
				if cfg.ThemeID == nil || *cfg.ThemeID != 4 {
					t.Fatalf("%+v", cfg)
				}
			case "dark-theme-id":
				if cfg.DarkThemeID == nil || *cfg.DarkThemeID != 201 {
					t.Fatalf("%+v", cfg)
				}
			}
		})
	}
	for _, bad := range [][2]string{{"layout-engine", "grid"}, {"sketch", "maybe"}, {"theme-id", "999"}, {"theme-id", "x"}, {"pad", "1"}} {
		if _, err := setConfig("a -> b\n", bad[0], bad[1]); err == nil {
			t.Fatalf("%v should be rejected", bad)
		}
	}
	if cfg, err := readConfig("a -> b\n"); err != nil || cfg != (Config{Engine: engineTala}) {
		t.Fatalf("defaults: %+v %v", cfg, err)
	}
	if _, err := readConfig("vars: {d2-config: {layout-engine: grid}}\na -> b\n"); err == nil {
		t.Fatal("an unknown engine should be an error")
	}
}

func TestEmptyThemeRemovesTheKeys(t *testing.T) {
	src, err := setConfig("a -> b\n", "theme-id", "4")
	if err != nil {
		t.Fatal(err)
	}
	src, err = setConfig(src, "dark-theme-id", "201")
	if err != nil {
		t.Fatal(err)
	}
	src, err = setConfig(src, "theme-id", "")
	if err != nil {
		t.Fatal(err)
	}
	if cfg, _ := readConfig(src); cfg.ThemeID != nil || cfg.DarkThemeID == nil {
		t.Fatalf("%+v\n%s", cfg, src)
	}
	src, err = setConfig(src, "dark-theme-id", "")
	if err != nil {
		t.Fatal(err)
	}
	if src != "a -> b\n" {
		t.Fatalf("%q", src)
	}
}

func TestDescribeListsD2Themes(t *testing.T) {
	c := Describe()
	if len(c.Themes) < 10 || len(c.DarkThemes) < 2 || len(c.Engines) != 3 || len(c.Charsets) != 2 {
		t.Fatalf("%+v", c)
	}
}

func TestConfigEditsAreUndoable(t *testing.T) {
	h := newHarness(t, "testdata/arch.d2")
	before := h.src
	h.mustCommit(Edit{Kind: "config", Key: "sketch", To: "true"})
	h.mustCommit(Edit{Kind: "config", Key: "theme-id", To: "4"})
	h.mustCommit(Edit{Kind: "config", Key: "dark-theme-id", To: "201"})
	cfg := h.view().Config
	if !cfg.Sketch || cfg.ThemeID == nil || *cfg.ThemeID != 4 || cfg.DarkThemeID == nil || *cfg.DarkThemeID != 201 {
		t.Fatalf("%+v", cfg)
	}
	for range 3 {
		if _, err := h.session.Undo(); err != nil {
			t.Fatal(err)
		}
	}
	if h.src != before {
		t.Fatalf("undo did not restore the file:\n%s", h.src)
	}
}

func TestEngineTimings(t *testing.T) {
	for _, f := range examples(t) {
		for _, engine := range allEngines {
			h := withEngine(t, f, engine)
			started := time.Now()
			if _, err := h.session.Open(h.src); err != nil {
				t.Fatal(err)
			}
			t.Logf("%s %s: open %.0f ms", filepath.Base(f), engine, float64(time.Since(started).Microseconds())/1000)
		}
	}
}
