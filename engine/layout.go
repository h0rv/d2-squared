package engine

import (
	"bytes"
	"context"
	"sync"
	"time"

	"github.com/d2lang/d2/d2graph"
	"github.com/d2lang/d2/d2layouts/d2talalayout"
	"github.com/d2lang/d2/d2lib"
	"github.com/d2lang/d2/d2renderers/d2svg"
	"github.com/d2lang/d2/d2target"
	"github.com/d2lang/d2/lib/geo"
	d2log "github.com/d2lang/d2/lib/log"
	"github.com/d2lang/d2/lib/textmeasure"
	"github.com/d2lang/util-go/go2"
)

const pad = 40

type Shape struct {
	ID     string   `json:"id"`
	Type   string   `json:"type"`
	X      int      `json:"x"`
	Y      int      `json:"y"`
	Width  int      `json:"width"`
	Height int      `json:"height"`
	Pinned bool     `json:"pinned"`
	Cols   []string `json:"cols,omitempty"`
	PK     int      `json:"pk"`
}

type Conn struct {
	ID    string       `json:"id"`
	Src   string       `json:"src"`
	Dst   string       `json:"dst"`
	Route [][2]float64 `json:"route"`
}

type Layout struct {
	SVG      string  `json:"svg"`
	Shapes   []Shape `json:"shapes"`
	Conns    []Conn  `json:"conns"`
	OriginX  int     `json:"originX"`
	OriginY  int     `json:"originY"`
	LayoutMS float64 `json:"layoutMs"`

	graph *d2graph.Graph
	orig  *snapshot

	userSized map[string]bool
	mu        *sync.Mutex
}

var rulers = sync.Pool{New: func() any {
	r, err := textmeasure.NewRuler()
	if err != nil {
		panic(err)
	}
	return r
}}

type layoutFn func(ctx context.Context, g *d2graph.Graph) error

const stableHash = "d2squared"

func talaLayout(seeds []int64) layoutFn {
	return func(ctx context.Context, g *d2graph.Graph) error {
		o := d2talalayout.DefaultOptions()
		if len(seeds) > 0 {
			o.Seeds = seeds
		}
		return d2talalayout.Layout(ctx, g, &o)
	}
}

func layoutWith(ctx context.Context, source string, layout layoutFn) (*Layout, error) {
	started := time.Now()
	ruler := rulers.Get().(*textmeasure.Ruler)
	defer rulers.Put(ruler)
	opts := &d2lib.CompileOptions{
		Ruler:          ruler,
		Layout:         go2.Pointer("tala"),
		LayoutResolver: func(string) (d2graph.LayoutGraph, error) { return d2graph.LayoutGraph(layout), nil },
		RouterResolver: func(string) (d2graph.RouteEdges, error) { return d2talalayout.RouteEdges, nil },
	}
	renderOpts := &d2svg.RenderOpts{Pad: go2.Pointer(int64(pad)), NoXMLTag: go2.Pointer(true), ThemeID: go2.Pointer(int64(0)), DarkThemeID: go2.Pointer(int64(200))}
	diagram, g, err := d2lib.Compile(d2log.WithDefault(ctx), source, opts, renderOpts)
	if err != nil {
		return nil, err
	}
	svg, err := d2svg.Render(diagram, renderOpts)
	if err != nil {
		return nil, err
	}
	hash, err := diagram.HashID(renderOpts.Salt)
	if err != nil {
		return nil, err
	}
	svg = bytes.ReplaceAll(svg, []byte(hash), []byte(stableHash))
	pinned := map[string]bool{}
	for _, obj := range g.Objects {
		if obj.Top != nil || obj.Left != nil {
			pinned[obj.AbsID()] = true
		}
	}
	l := &Layout{SVG: string(svg), Shapes: []Shape{}, Conns: []Conn{}, graph: g, mu: &sync.Mutex{}}
	for _, sh := range diagram.Shapes {
		s := Shape{ID: sh.ID, Type: sh.Type, X: sh.Pos.X, Y: sh.Pos.Y, Width: sh.Width, Height: sh.Height,
			Pinned: pinned[sh.ID], PK: -1}
		if sh.Type == d2target.ShapeSQLTable {
			for i, c := range sh.SQLTable.Columns {
				s.Cols = append(s.Cols, c.Name.Label)
				for _, k := range c.Constraint {
					if k == "primary_key" && s.PK < 0 {
						s.PK = i
					}
				}
			}
		}
		l.Shapes = append(l.Shapes, s)
	}
	for _, c := range diagram.Connections {
		conn := Conn{ID: c.ID, Src: c.Src, Dst: c.Dst}
		for _, p := range c.Route {
			conn.Route = append(conn.Route, [2]float64{p.X, p.Y})
		}
		l.Conns = append(l.Conns, conn)
	}
	tl, _ := diagram.BoundingBox()
	l.OriginX, l.OriginY = tl.X-pad, tl.Y-pad
	l.LayoutMS = float64(time.Since(started).Microseconds()) / 1000
	return l, nil
}

func (l *Layout) shape(id string) (Shape, bool) {
	for _, s := range l.Shapes {
		if s.ID == id {
			return s, true
		}
	}
	return Shape{}, false
}

func (l *Layout) shapeMap() map[string]Shape {
	m := make(map[string]Shape, len(l.Shapes))
	for _, s := range l.Shapes {
		m[s.ID] = s
	}
	return m
}

func (l *Layout) conn(id string) (Conn, bool) {
	for _, c := range l.Conns {
		if c.ID == id {
			return c, true
		}
	}
	return Conn{}, false
}

func (l *Layout) isContainer(id string) bool {
	for _, s := range l.Shapes {
		if parentID(s.ID) == id {
			return true
		}
	}
	return false
}

type snapshot struct {
	topLeft map[*d2graph.Object]geo.Point
	routes  map[*d2graph.Edge][]*geo.Point
}

func takeSnapshot(g *d2graph.Graph) *snapshot {
	snap := &snapshot{topLeft: map[*d2graph.Object]geo.Point{}, routes: map[*d2graph.Edge][]*geo.Point{}}
	for _, obj := range g.Objects {
		snap.topLeft[obj] = *obj.TopLeft
	}
	for _, e := range g.Edges {
		snap.routes[e] = e.Route
	}
	return snap
}

func (snap *snapshot) restore() {
	for obj, p := range snap.topLeft {
		obj.TopLeft = geo.NewPoint(p.X, p.Y)
	}
	for e, route := range snap.routes {
		e.Route = route
	}
}

type Path struct {
	ID    string       `json:"id"`
	Src   string       `json:"src"`
	Dst   string       `json:"dst"`
	Route [][2]float64 `json:"route"`
}

func (l *Layout) reroute(moved string, dx, dy float64) ([]Path, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.orig == nil {
		l.orig = takeSnapshot(l.graph)
	}
	defer l.orig.restore()
	inside := map[*d2graph.Object]bool{}
	for _, obj := range l.graph.Objects {
		if within(obj.AbsID(), moved) {
			inside[obj] = true
			obj.TopLeft = geo.NewPoint(obj.TopLeft.X+dx, obj.TopLeft.Y+dy)
		}
	}
	var edges []*d2graph.Edge
	for _, e := range l.graph.Edges {
		if inside[e.Src] != inside[e.Dst] {
			edges = append(edges, e)
		}
	}
	if len(edges) == 0 {
		return nil, nil
	}
	if err := d2talalayout.RouteEdges(d2log.WithDefault(context.Background()), l.graph, edges); err != nil {
		return nil, err
	}
	paths := make([]Path, 0, len(edges))
	for _, e := range edges {
		p := Path{ID: e.AbsID(), Src: e.Src.AbsID(), Dst: e.Dst.AbsID()}
		for _, pt := range e.Route {
			p.Route = append(p.Route, [2]float64{pt.X, pt.Y})
		}
		paths = append(paths, p)
	}
	return paths, nil
}

func sameColumn(a, b *int) bool {
	return (a == nil) == (b == nil) && (a == nil || *a == *b)
}

func routeOnly(base *Layout, moved string, dx, dy float64) layoutFn {
	return func(ctx context.Context, g *d2graph.Graph) error {
		base.mu.Lock()
		defer base.mu.Unlock()
		objects := map[string]*d2graph.Object{}
		for _, obj := range base.graph.Objects {
			objects[obj.AbsID()] = obj
		}
		for _, obj := range g.Objects {
			b, ok := objects[obj.AbsID()]
			if !ok {
				return errUnknownShape(obj.AbsID())
			}
			tl := b.TopLeft.Copy()
			if within(obj.AbsID(), moved) {
				tl = geo.NewPoint(tl.X+dx, tl.Y+dy)
			}
			obj.Box = geo.NewBox(tl, b.Width, b.Height)
			obj.LabelPosition, obj.IconPosition = b.LabelPosition, b.IconPosition
		}
		edges := map[string]*d2graph.Edge{}
		for _, e := range base.graph.Edges {
			edges[e.AbsID()] = e
		}
		var fresh []*d2graph.Edge
		for _, e := range g.Edges {
			b, ok := edges[e.AbsID()]
			if !ok || b.Src.AbsID() != e.Src.AbsID() || b.Dst.AbsID() != e.Dst.AbsID() ||
				!sameColumn(b.SrcTableColumnIndex, e.SrcTableColumnIndex) || !sameColumn(b.DstTableColumnIndex, e.DstTableColumnIndex) ||
				(moved != "" && (within(e.Src.AbsID(), moved) != within(e.Dst.AbsID(), moved))) {
				fresh = append(fresh, e)
				continue
			}
			e.Route, e.IsCurve = b.Route, b.IsCurve
			e.LabelPosition, e.LabelPercentage = b.LabelPosition, b.LabelPercentage
			if moved != "" && within(e.Src.AbsID(), moved) {
				shifted := make([]*geo.Point, len(e.Route))
				for i, p := range e.Route {
					shifted[i] = geo.NewPoint(p.X+dx, p.Y+dy)
				}
				e.Route = shifted
			}
		}
		return d2talalayout.RouteEdges(ctx, g, fresh)
	}
}
