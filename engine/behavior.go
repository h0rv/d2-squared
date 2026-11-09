package engine

import (
	"context"
	"fmt"
	"sort"
	"strconv"
)

const (
	maxMoveCandidates      = 32
	maxReconnectCandidates = 12
)

var previewSeeds = []int64{1}

type Candidate struct {
	Key      string       `json:"key"`
	Label    string       `json:"label"`
	Edit     Edit         `json:"edit"`
	Landing  Shape        `json:"landing"`
	Route    [][2]float64 `json:"route,omitempty"`
	Diff     []DiffLine   `json:"diff"`
	PinLines int          `json:"pinLines"`
	MS       float64      `json:"ms"`
	Cached   bool         `json:"cached"`

	layout *Layout
	source string
}

type Behavior interface {
	Name() string
	Targets(l *Layout) []Target
	Candidates(l *Layout, t Target, p Point) []Edit
	Build(ctx context.Context, base *Layout, source string, e Edit) (*Candidate, error)
}

var registry = map[string]Behavior{}
var behaviorOrder []Behavior

func Register(b Behavior, kinds ...string) {
	behaviorOrder = append(behaviorOrder, b)
	for _, k := range kinds {
		registry[k] = b
	}
}

func init() {
	Register(reparent{}, "move")
	Register(reconnect{}, "reconnect")
	Register(pin{}, "pin")
	Register(direction{}, "direction", "unpin")
}

func hasTarget(b Behavior, l *Layout, t Target) bool {
	for _, c := range b.Targets(l) {
		if c == t {
			return true
		}
	}
	return false
}

func markPinned(l *Layout, source string) (*Layout, error) {
	g, err := compile(source)
	if err != nil {
		return nil, err
	}
	pinned := map[string]bool{}
	for _, obj := range g.Objects {
		if obj.Top != nil || obj.Left != nil {
			pinned[obj.AbsID()] = true
		}
	}
	out := *l
	out.Shapes = append([]Shape(nil), l.Shapes...)
	for i := range out.Shapes {
		out.Shapes[i].Pinned = pinned[out.Shapes[i].ID]
	}
	return &out, nil
}

func allIDs(l *Layout) []string {
	ids := make([]string, len(l.Shapes))
	for i, s := range l.Shapes {
		ids[i] = s.ID
	}
	return ids
}

func nearestShapes(l *Layout, p Point, keep func(Shape) bool, limit int) []Shape {
	var shapes []Shape
	for _, s := range l.Shapes {
		if keep(s) {
			shapes = append(shapes, s)
		}
	}
	sort.SliceStable(shapes, func(i, j int) bool { return rectDistance(shapes[i], p) < rectDistance(shapes[j], p) })
	if len(shapes) > limit {
		shapes = shapes[:limit]
	}
	return shapes
}

type reparent struct{}

func (reparent) Name() string { return "reparent" }

func (reparent) Targets(l *Layout) []Target {
	targets := make([]Target, 0, len(l.Shapes))
	for _, s := range l.Shapes {
		targets = append(targets, Target{Kind: "node", ID: s.ID})
	}
	return targets
}

func (reparent) Candidates(l *Layout, t Target, p Point) []Edit {
	if t.Kind != "node" {
		return nil
	}
	var edits []Edit
	limit := maxMoveCandidates
	if parentID(t.ID) != "" {
		edits = append(edits, Edit{Kind: "move", Key: t.ID})
		limit--
	}
	for _, s := range nearestShapes(l, p, func(s Shape) bool {
		return !within(s.ID, t.ID) && s.ID != parentID(t.ID) && l.isContainer(s.ID)
	}, limit) {
		edits = append(edits, Edit{Kind: "move", Key: t.ID, To: s.ID})
	}
	return edits
}

func (reparent) Build(ctx context.Context, base *Layout, source string, e Edit) (*Candidate, error) {
	clean, err := applyMove(source, e)
	if err != nil {
		return nil, err
	}
	newID := movedID(e)
	var outside []string
	for _, s := range base.Shapes {
		if !within(s.ID, e.Key) {
			outside = append(outside, s.ID)
		}
	}
	pinned, err := pinSource(clean, outside, base.shapeMap())
	if err != nil {
		return nil, err
	}
	layout, err := layoutWith(ctx, pinned, talaLayout(previewSeeds))
	if err != nil {
		return nil, err
	}
	var subtree []string
	for _, s := range layout.Shapes {
		if within(s.ID, newID) {
			subtree = append(subtree, s.ID)
		}
	}
	final, err := pinSource(pinned, subtree, layout.shapeMap())
	if err != nil {
		return nil, err
	}
	if layout, err = markPinned(layout, final); err != nil {
		return nil, err
	}
	landing, _ := layout.shape(newID)
	label := "into " + e.To
	if e.To == "" {
		label = "to top level"
	}
	return &Candidate{Label: label, Edit: e, Landing: landing, Diff: diffLines(source, clean, 1),
		PinLines: countAdded(clean, final), layout: layout, source: final}, nil
}

type reconnect struct{}

func (reconnect) Name() string { return "reconnect" }

func (reconnect) Targets(l *Layout) []Target {
	var targets []Target
	for _, c := range l.Conns {
		targets = append(targets, Target{Kind: "edgeEnd", Edge: c.ID, End: "src"}, Target{Kind: "edgeEnd", Edge: c.ID, End: "dst"})
	}
	return targets
}

func columnTarget(s Shape, col int) string {
	if len(s.Cols) == 0 {
		return s.ID
	}
	if col < 0 || col >= len(s.Cols) {
		col = max(s.PK, 0)
	}
	return s.ID + "." + s.Cols[col]
}

func (reconnect) Candidates(l *Layout, t Target, p Point) []Edit {
	c, ok := l.conn(t.Edge)
	if !ok || t.Kind != "edgeEnd" {
		return nil
	}
	current, other := c.Src, c.Dst
	if t.End == "dst" {
		current, other = c.Dst, c.Src
	}
	var edits []Edit
	for _, s := range nearestShapes(l, p, func(s Shape) bool {
		return s.ID != current && s.ID != other && !l.isContainer(s.ID)
	}, maxReconnectCandidates) {
		edits = append(edits, Edit{Kind: "reconnect", Key: t.Edge, End: t.End, To: columnTarget(s, -1)})
	}
	return edits
}

func (reconnect) Build(ctx context.Context, base *Layout, source string, e Edit) (*Candidate, error) {
	clean, err := applyReconnect(source, e)
	if err != nil {
		return nil, err
	}
	pinned, err := pinSource(clean, allIDs(base), base.shapeMap())
	if err != nil {
		return nil, err
	}
	layout, err := layoutWith(ctx, pinned, routeOnly(base, "", 0, 0))
	if err != nil {
		return nil, err
	}
	if layout, err = markPinned(layout, pinned); err != nil {
		return nil, err
	}
	old, _ := base.conn(e.Key)
	table := e.To
	if _, ok := base.shape(table); !ok {
		table = parentID(table)
	}
	src, dst := old.Src, table
	if e.End == "src" {
		src, dst = table, old.Dst
	}
	cand := &Candidate{Label: e.End + " to " + e.To, Edit: e, Diff: diffLines(source, clean, 1),
		PinLines: countAdded(clean, pinned), layout: layout, source: pinned}
	cand.Landing, _ = base.shape(table)
	for _, c := range layout.Conns {
		if c.Src == src && c.Dst == dst {
			cand.Route = c.Route
		}
	}
	return cand, nil
}

type pin struct{}

func (pin) Name() string { return "pin" }

func (pin) Targets(l *Layout) []Target { return reparent{}.Targets(l) }

func (pin) Candidates(*Layout, Target, Point) []Edit { return nil }

func (pin) Build(ctx context.Context, base *Layout, source string, e Edit) (*Candidate, error) {
	moved, ok := base.shape(e.Key)
	if !ok {
		return nil, errUnknownShape(e.Key)
	}
	dx, dy := e.Left-moved.X, e.Top-moved.Y
	shapes := base.shapeMap()
	for id, s := range shapes {
		if within(id, e.Key) {
			s.X += dx
			s.Y += dy
			shapes[id] = s
		}
	}
	pinned, err := pinSource(source, allIDs(base), shapes)
	if err != nil {
		return nil, err
	}
	run := routeOnly(base, e.Key, float64(dx), float64(dy))
	if parentID(e.Key) != "" {
		run = talaLayout(previewSeeds)
	}
	layout, err := layoutWith(ctx, pinned, run)
	if err != nil {
		return nil, err
	}
	if layout, err = markPinned(layout, pinned); err != nil {
		return nil, err
	}
	landing, _ := layout.shape(e.Key)
	return &Candidate{Label: "pin " + e.Key, Edit: e, Landing: landing,
		Diff:     []DiffLine{{Op: "+", Text: "left: " + strconv.Itoa(e.Left)}, {Op: "+", Text: "top: " + strconv.Itoa(e.Top)}},
		PinLines: countAdded(source, pinned), layout: layout, source: pinned}, nil
}

type direction struct{}

func (direction) Name() string { return "direction" }

func (direction) Targets(l *Layout) []Target { return nil }

func (direction) Candidates(*Layout, Target, Point) []Edit { return nil }

func (direction) Build(ctx context.Context, base *Layout, source string, e Edit) (*Candidate, error) {
	clean, err := unpinAll(source, base.userSized)
	if e.Kind == "unpin" && e.Key != "" {
		clean, err = unpinSingle(source, e.Key, base.userSized)
	}
	if err != nil {
		return nil, err
	}
	label := "unpin all"
	if e.Kind == "direction" {
		if clean, err = setDirection(clean, e.Key, e.To); err != nil {
			return nil, err
		}
		label = fmt.Sprintf("direction %s", e.To)
	}
	layout, err := layoutWith(ctx, clean, talaLayout(previewSeeds))
	if err != nil {
		return nil, err
	}
	return &Candidate{Label: label, Edit: e, Diff: diffLines(source, clean, 1), layout: layout, source: clean}, nil
}
