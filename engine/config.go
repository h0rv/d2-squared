package engine

import (
	"context"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/d2lang/d2/d2ast"
	"github.com/d2lang/d2/d2compiler"
	"github.com/d2lang/d2/d2format"
	"github.com/d2lang/d2/d2parser"
	"github.com/d2lang/d2/d2themes/d2themescatalog"
)

const (
	engineTala  = "tala"
	engineELK   = "elk"
	engineDagre = "dagre"

	defaultTheme     = 0
	defaultDarkTheme = 200
)

var engines = []string{engineTala, engineELK, engineDagre}

type Config struct {
	Engine      string `json:"engine"`
	Sketch      bool   `json:"sketch"`
	ThemeID     int64  `json:"themeId"`
	DarkThemeID int64  `json:"darkThemeId"`
}

func readConfig(source string) (Config, error) {
	_, found, err := d2compiler.Compile("", strings.NewReader(source), nil)
	if err != nil {
		return Config{}, err
	}
	c := Config{Engine: engineTala, ThemeID: defaultTheme, DarkThemeID: defaultDarkTheme}
	if found == nil {
		return c, nil
	}
	if found.LayoutEngine != nil {
		c.Engine = *found.LayoutEngine
	}
	if found.Sketch != nil {
		c.Sketch = *found.Sketch
	}
	if found.ThemeID != nil {
		c.ThemeID = *found.ThemeID
	}
	if found.DarkThemeID != nil {
		c.DarkThemeID = *found.DarkThemeID
	}
	if !slices.Contains(engines, c.Engine) {
		return Config{}, fmt.Errorf("the layout engine %q is not available, use tala, elk or dagre", c.Engine)
	}
	return c, nil
}

func checkConfig(key, value string) error {
	switch key {
	case "layout-engine":
		if !slices.Contains(engines, value) {
			return fmt.Errorf("the layout engine %q is not available", value)
		}
	case "sketch":
		if value != "true" && value != "false" {
			return fmt.Errorf("sketch must be true or false")
		}
	case "theme-id", "dark-theme-id":
		id, err := strconv.ParseInt(value, 10, 64)
		if err != nil || d2themescatalog.Find(id).Name == "" {
			return fmt.Errorf("unknown theme %q", value)
		}
	default:
		return fmt.Errorf("unknown setting %q", key)
	}
	return nil
}

func childKey(m *d2ast.Map, name string) *d2ast.Key {
	for _, n := range m.Nodes {
		k := n.MapKey
		if k != nil && k.Key != nil && len(k.Key.Path) == 1 && len(k.Edges) == 0 && k.Key.Path[0].ScalarString() == name {
			return k
		}
	}
	return nil
}

func entryKey(text string) (*d2ast.Key, error) { return d2parser.ParseMapKey(text) }

func setConfig(source, key, value string) (string, error) {
	if err := checkConfig(key, value); err != nil {
		return "", err
	}
	ast, err := d2parser.Parse("", strings.NewReader(source), nil)
	if err != nil {
		return "", err
	}
	entry, err := entryKey(key + ": " + value)
	if err != nil {
		return "", err
	}
	vars := childKey(ast, "vars")
	switch {
	case vars == nil:
		block, err := entryKey(fmt.Sprintf("vars: {d2-config: {%s: %s}}", key, value))
		if err != nil {
			return "", err
		}
		ast.Nodes = append([]d2ast.MapNodeBox{d2ast.MakeMapNodeBox(block)}, ast.Nodes...)
	case vars.Value.Map == nil:
		return "", fmt.Errorf("vars is not a map")
	default:
		config := childKey(vars.Value.Map, "d2-config")
		if config == nil {
			block, err := entryKey(fmt.Sprintf("d2-config: {%s: %s}", key, value))
			if err != nil {
				return "", err
			}
			vars.Value.Map.Nodes = append(vars.Value.Map.Nodes, d2ast.MakeMapNodeBox(block))
			break
		}
		if config.Value.Map == nil {
			return "", fmt.Errorf("d2-config is not a map")
		}
		if existing := childKey(config.Value.Map, key); existing != nil {
			existing.Value = entry.Value
		} else {
			config.Value.Map.Nodes = append(config.Value.Map.Nodes, d2ast.MakeMapNodeBox(entry))
		}
	}
	out := d2format.Format(ast)
	if _, err := readConfig(out); err != nil {
		return "", err
	}
	return out, nil
}

type configure struct{}

func (configure) Name() string { return "config" }

func (configure) Targets(*Layout) []Target { return nil }

func (configure) Candidates(*Layout, Target, Point) []Edit { return nil }

func (configure) Build(ctx context.Context, base *Layout, source string, e Edit) (*Candidate, error) {
	clean, err := setConfig(source, e.Key, e.To)
	if err != nil {
		return nil, err
	}
	return plainCandidate(ctx, source, clean, e, "", "set "+e.Key)
}
