package engine

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strconv"
)

const (
	maxMoveCandidates      = 32
	maxReconnectCandidates = 12
	minSide                = 24
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
	landID string
}

var errTalaOnly = errors.New("Placing and resizing need the TALA layout engine")

func plainCandidate(ctx context.Context, source, clean string, e Edit, landID, label string) (*Candidate, error) {
	layout, err := layoutWith(ctx, clean, engineLayout(previewSeeds))
	if err != nil {
		return nil, err
	}
	landing, _ := layout.shape(landID)
	return &Candidate{Label: label, Edit: e, Landing: landing, Diff: diffLines(source, clean, 1), layout: layout, source: clean, landID: landID}, nil
}

func (c *Candidate) hugGroups(ctx context.Context, sized map[string]bool) error {
	hugged, err := hug(c.source, sized)
	if err != nil || hugged == c.source {
		return err
	}
	layout, err := layoutWith(ctx, hugged, engineLayout(previewSeeds))
	if err != nil {
		return err
	}
	if layout, err = markPinned(layout, hugged); err != nil {
		return err
	}
	c.source, c.layout = hugged, layout
	if s, ok := layout.shape(c.landID); ok {
		c.Landing = s
	}
	return nil
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
	Register(tidy{}, "tidy")
	Register(resize{}, "resize")
	Register(configure{}, "config")
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
		out.Shapes[i].Pinned = l.tala() && pinned[out.Shapes[i].ID]
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
	label := "into " + e.To
	if e.To == "" {
		label = "to top level"
	}
	if !base.tala() {
		return plainCandidate(ctx, source, clean, e, newID, label)
	}
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
	layout, err := layoutWith(ctx, pinned, engineLayout(previewSeeds))
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
	return &Candidate{Label: label, Edit: e, Landing: landing, Diff: diffLines(source, clean, 1),
		PinLines: countAdded(clean, final), layout: layout, source: final, landID: newID}, nil
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
	table := e.To
	if _, ok := base.shape(table); !ok {
		table = parentID(table)
	}
	pinned, run := clean, engineLayout(previewSeeds)
	if base.tala() {
		if pinned, err = pinSource(clean, allIDs(base), base.shapeMap()); err != nil {
			return nil, err
		}
		run = fixedLayout(copyGeometry(base, "", 0, 0))
	}
	layout, err := layoutWith(ctx, pinned, run)
	if err != nil {
		return nil, err
	}
	if layout, err = markPinned(layout, pinned); err != nil {
		return nil, err
	}
	old, _ := base.conn(e.Key)
	src, dst := old.Src, table
	if e.End == "src" {
		src, dst = table, old.Dst
	}
	cand := &Candidate{Label: e.End + " to " + e.To, Edit: e, Diff: diffLines(source, clean, 1),
		PinLines: countAdded(clean, pinned), layout: layout, source: pinned}
	cand.Landing, _ = base.shape(table)
	cand.landID = table
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
	if !base.tala() {
		return nil, errTalaOnly
	}
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
	run := fixedLayout(copyGeometry(base, e.Key, float64(dx), float64(dy)))
	if parentID(e.Key) != "" {
		run = engineLayout(previewSeeds)
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
		PinLines: countAdded(source, pinned), layout: layout, source: pinned, landID: e.Key}, nil
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
	layout, err := layoutWith(ctx, clean, engineLayout(previewSeeds))
	if err != nil {
		return nil, err
	}
	return &Candidate{Label: label, Edit: e, Diff: diffLines(source, clean, 1), layout: layout, source: clean}, nil
}

type tidy struct{}

func (tidy) Name() string { return "tidy" }

func (tidy) Targets(*Layout) []Target { return nil }

func (tidy) Candidates(*Layout, Target, Point) []Edit { return nil }

func (tidy) Build(ctx context.Context, base *Layout, source string, e Edit) (*Candidate, error) {
	if !base.isContainer(e.Key) {
		return nil, fmt.Errorf("%s is not a group", e.Key)
	}
	g, err := compile(source)
	if err != nil {
		return nil, err
	}
	var inside, outside []string
	for _, s := range base.Shapes {
		if within(s.ID, e.Key) && s.ID != e.Key {
			inside = append(inside, s.ID)
		} else {
			outside = append(outside, s.ID)
		}
	}
	for _, id := range inside {
		if g, err = unpinOne(g, id, base.userSized[id]); err != nil {
			return nil, err
		}
	}
	clean := format(g)
	pinned := clean
	if base.tala() {
		if pinned, err = pinSource(clean, outside, base.shapeMap()); err != nil {
			return nil, err
		}
	}
	layout, err := layoutWith(ctx, pinned, engineLayout(previewSeeds))
	if err != nil {
		return nil, err
	}
	if layout, err = markPinned(layout, pinned); err != nil {
		return nil, err
	}
	landing, _ := layout.shape(e.Key)
	return &Candidate{Label: "tidy " + e.Key, Edit: e, Landing: landing, Diff: diffLines(source, clean, 1),
		PinLines: countAdded(clean, pinned), layout: layout, source: pinned, landID: e.Key}, nil
}

type resize struct{}

func (resize) Name() string { return "resize" }

func (resize) Targets(*Layout) []Target { return nil }

func (resize) Candidates(*Layout, Target, Point) []Edit { return nil }

func (resize) Build(ctx context.Context, base *Layout, source string, e Edit) (*Candidate, error) {
	if !base.tala() {
		return nil, errTalaOnly
	}
	s, ok := base.shape(e.Key)
	if !ok {
		return nil, errUnknownShape(e.Key)
	}
	shapes := base.shapeMap()
	s.X, s.Y, s.Width, s.Height = e.Left, e.Top, max(e.Width, minSide), max(e.Height, minSide)
	shapes[e.Key] = s
	pinned, err := pinSource(source, allIDs(base), shapes)
	if err != nil {
		return nil, err
	}
	g, err := compile(pinned)
	if err != nil {
		return nil, err
	}
	fields := [][2]string{{"width", strconv.Itoa(s.Width)}, {"height", strconv.Itoa(s.Height)}}
	if obj := findObject(g, e.Key); obj != nil {
		fields = slices.DeleteFunc(fields, func(f [2]string) bool { return scalarIs(obj, f[0], f[1]) })
	}
	if g, err = setFields(g, e.Key, fields); err != nil {
		return nil, err
	}
	sized := format(g)
	layout, err := layoutWith(ctx, sized, engineLayout(previewSeeds))
	if err != nil {
		return nil, err
	}
	if layout, err = markPinned(layout, sized); err != nil {
		return nil, err
	}
	landing, _ := layout.shape(e.Key)
	return &Candidate{Label: "resize " + e.Key, Edit: e, Landing: landing,
		Diff:     []DiffLine{{Op: "+", Text: "width: " + strconv.Itoa(s.Width)}, {Op: "+", Text: "height: " + strconv.Itoa(s.Height)}},
		PinLines: countAdded(source, sized), layout: layout, source: sized, landID: e.Key}, nil
}
