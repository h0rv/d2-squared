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
	"github.com/d2lang/d2/d2themes"
	"github.com/d2lang/d2/d2themes/d2themescatalog"
)

const (
	engineTala  = "tala"
	engineELK   = "elk"
	engineDagre = "dagre"
)

var engines = []string{engineTala, engineELK, engineDagre}

type Config struct {
	Engine      string `json:"engine"`
	Sketch      bool   `json:"sketch"`
	ThemeID     *int64 `json:"themeId,omitempty"`
	DarkThemeID *int64 `json:"darkThemeId,omitempty"`
}

type ThemeChoice struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

type Choice struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Catalog struct {
	Themes     []ThemeChoice `json:"themes"`
	DarkThemes []ThemeChoice `json:"darkThemes"`
	Engines    []Choice      `json:"engines"`
	Charsets   []Choice      `json:"charsets"`
	Theme      int64         `json:"theme"`
	DarkTheme  int64         `json:"darkTheme"`
}

func (c Config) darkTheme() *int64 {
	if c.DarkThemeID != nil {
		return c.DarkThemeID
	}
	return &d2themescatalog.DarkMauve.ID
}

func themeChoices(themes []d2themes.Theme) []ThemeChoice {
	out := make([]ThemeChoice, 0, len(themes))
	for _, t := range themes {
		out = append(out, ThemeChoice{ID: t.ID, Name: t.Name})
	}
	return out
}

func Describe() Catalog {
	return Catalog{
		Themes:     themeChoices(d2themescatalog.LightCatalog),
		DarkThemes: themeChoices(d2themescatalog.DarkCatalog),
		Engines:    []Choice{{engineTala, "TALA"}, {engineELK, "ELK"}, {engineDagre, "dagre"}},
		Charsets:   []Choice{{"unicode", "Unicode"}, {"ascii", "ASCII"}},
		Theme:      d2themescatalog.NeutralDefault.ID,
		DarkTheme:  d2themescatalog.DarkMauve.ID,
	}
}

func readConfig(source string) (Config, error) {
	_, found, err := d2compiler.Compile("", strings.NewReader(source), nil)
	if err != nil {
		return Config{}, err
	}
	c := Config{Engine: engineTala}
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
		c.ThemeID = found.ThemeID
	}
	if found.DarkThemeID != nil {
		c.DarkThemeID = found.DarkThemeID
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
		if value == "" {
			return nil
		}
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
	vars := childKey(ast, "vars")
	if value == "" {
		removeConfigKey(ast, vars, key)
		out := d2format.Format(ast)
		if _, err := readConfig(out); err != nil {
			return "", err
		}
		return out, nil
	}
	entry, err := entryKey(key + ": " + value)
	if err != nil {
		return "", err
	}
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

func dropNode(m *d2ast.Map, key *d2ast.Key) {
	m.Nodes = slices.DeleteFunc(m.Nodes, func(n d2ast.MapNodeBox) bool { return n.MapKey == key })
}

func removeConfigKey(ast *d2ast.Map, vars *d2ast.Key, name string) {
	if vars == nil || vars.Value.Map == nil {
		return
	}
	config := childKey(vars.Value.Map, "d2-config")
	if config == nil || config.Value.Map == nil {
		return
	}
	if existing := childKey(config.Value.Map, name); existing != nil {
		dropNode(config.Value.Map, existing)
	}
	if len(config.Value.Map.Nodes) == 0 {
		dropNode(vars.Value.Map, config)
	}
	if len(vars.Value.Map.Nodes) == 0 {
		dropNode(ast, vars)
	}
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
