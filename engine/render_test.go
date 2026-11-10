package engine

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestTextForEveryExample(t *testing.T) {
	for _, f := range examples(t) {
		for _, engine := range allEngines {
			t.Run(filepath.Base(f)+"/"+engine, func(t *testing.T) {
				h := withEngine(t, f, engine)
				label := exampleLabels[filepath.Base(f)]
				uni, err := h.session.Text(h.ctx(), true)
				if err != nil {
					t.Fatal(err)
				}
				if !strings.Contains(uni.Text, label) || !strings.ContainsAny(uni.Text, "┌└│─") {
					t.Fatalf("unicode text:\n%s", uni.Text)
				}
				plain, err := h.session.Text(h.ctx(), false)
				if err != nil {
					t.Fatal(err)
				}
				if !strings.Contains(plain.Text, label) || !strings.Contains(plain.Text, "+") || strings.ContainsAny(plain.Text, "┌└│─") {
					t.Fatalf("ascii text:\n%s", plain.Text)
				}
				if (engine == engineDagre) != (uni.Note != "") {
					t.Fatalf("note = %q for %s", uni.Note, engine)
				}
				if uni.Version != h.view().Version {
					t.Fatal("text should carry the view version")
				}
			})
		}
	}
}

func TestExportSVG(t *testing.T) {
	for _, engine := range allEngines {
		t.Run(engine, func(t *testing.T) {
			h := withEngine(t, "../examples/architecture.d2", engine)
			h.mustCommit(Edit{Kind: "config", Key: "dark-theme-id", To: "200"})
			light, err := h.session.ExportSVG(h.ctx(), false)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.HasPrefix(string(light), "<?xml") || !strings.Contains(string(light), "<svg") || !strings.Contains(string(light), "Postgres") {
				t.Fatalf("not a standalone svg: %.200s", light)
			}
			dark, err := h.session.ExportSVG(h.ctx(), true)
			if err != nil || string(dark) == string(light) {
				t.Fatalf("dark export should differ: %v", err)
			}
		})
	}
	h := newHarness(t, "../examples/architecture.d2")
	plain, _ := h.session.ExportSVG(h.ctx(), false)
	h.mustCommit(Edit{Kind: "config", Key: "sketch", To: "true"})
	h.mustCommit(Edit{Kind: "config", Key: "theme-id", To: "4"})
	styled, err := h.session.ExportSVG(h.ctx(), false)
	if err != nil || string(styled) == string(plain) {
		t.Fatalf("the sketch and the theme should show in the export: %v", err)
	}
}
