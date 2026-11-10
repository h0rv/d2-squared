package engine

import (
	"context"
	"fmt"

	"github.com/d2lang/d2/d2renderers/d2ascii"
	"github.com/d2lang/d2/d2renderers/d2ascii/charset"
	"github.com/d2lang/d2/d2renderers/d2svg"
	d2log "github.com/d2lang/d2/lib/log"
)

type TextResult struct {
	Version int64  `json:"version"`
	Text    string `json:"text"`
	Note    string `json:"note"`
}

func renderText(ctx context.Context, source string, unicode bool, seeds []int64) (res TextResult, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("this diagram can't be shown as text: %v", r)
		}
	}()
	cfg, err := readConfig(source)
	if err != nil {
		return TextResult{}, err
	}
	if cfg.Engine == engineDagre {
		cfg.Engine = engineELK
		res.Note = "Shown with the ELK layout engine, because text can't be drawn with dagre."
	}
	diagram, _, _, err := compileSource(ctx, source, cfg, engineLayout(seeds)(cfg), cfg.ThemeID, nil)
	if err != nil {
		return TextResult{}, err
	}
	set := charset.ASCII
	if unicode {
		set = charset.Unicode
	}
	out, err := d2ascii.NewASCIIartist().Render(d2log.WithDefault(ctx), diagram, &d2ascii.RenderOpts{Charset: set})
	if err != nil {
		return TextResult{}, fmt.Errorf("this diagram can't be shown as text: %w", err)
	}
	res.Text = string(out)
	return res, nil
}

func (s *Session) Text(ctx context.Context, unicode bool) (TextResult, error) {
	v := s.Snapshot()
	if v.Layout == nil {
		return TextResult{}, errNoLayer
	}
	res, err := renderText(ctx, v.Source, unicode, s.seeds)
	if err != nil {
		return TextResult{}, err
	}
	res.Version = v.Version
	return res, nil
}

func renderSVG(ctx context.Context, source string, dark bool, seeds []int64) ([]byte, error) {
	cfg, err := readConfig(source)
	if err != nil {
		return nil, err
	}
	theme := cfg.ThemeID
	if dark {
		theme = cfg.darkTheme()
	}
	diagram, _, opts, err := compileSource(ctx, source, cfg, engineLayout(seeds)(cfg), theme, cfg.darkTheme())
	if err != nil {
		return nil, err
	}
	return d2svg.Render(diagram, opts)
}

func (s *Session) ExportSVG(ctx context.Context, dark bool) ([]byte, error) {
	v := s.Snapshot()
	if v.Layout == nil {
		return nil, errNoLayer
	}
	return renderSVG(ctx, v.Source, dark, s.seeds)
}
