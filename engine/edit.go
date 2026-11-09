package engine

import (
	"errors"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"

	"github.com/d2lang/d2/d2compiler"
	"github.com/d2lang/d2/d2format"
	"github.com/d2lang/d2/d2graph"
	"github.com/d2lang/d2/d2oracle"
	"github.com/d2lang/d2/d2parser"
	"github.com/d2lang/util-go/go2"
)

const containerPad = 60

type Edit struct {
	Kind string `json:"kind"`
	Key  string `json:"key"`
	To   string `json:"to"`
	End  string `json:"end"`
	Left int    `json:"left"`
	Top  int    `json:"top"`
}

type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type Target struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
	Edge string `json:"edge"`
	End  string `json:"end"`
}

func (e Edit) ID() string {
	return fmt.Sprintf("%s|%s|%s|%s|%d,%d", e.Kind, e.Key, e.End, e.To, e.Left, e.Top)
}

func errUnknownShape(id string) error { return fmt.Errorf("unknown shape %s", id) }

func compile(source string) (*d2graph.Graph, error) {
	g, _, err := d2compiler.Compile("", strings.NewReader(source), nil)
	return g, err
}

func parentID(id string) string {
	if i := strings.LastIndex(id, "."); i >= 0 {
		return id[:i]
	}
	return ""
}

func baseName(id string) string { return id[strings.LastIndex(id, ".")+1:] }

func within(id, root string) bool {
	return root != "" && (id == root || strings.HasPrefix(id, root+"."))
}

func joinID(parent, name string) string {
	if parent == "" {
		return name
	}
	return parent + "." + name
}

func findObject(g *d2graph.Graph, id string) *d2graph.Object {
	for _, obj := range g.Objects {
		if obj.AbsID() == id {
			return obj
		}
	}
	return nil
}

func rectDistance(s Shape, p Point) float64 {
	dx := math.Max(math.Max(float64(s.X)-p.X, p.X-float64(s.X+s.Width)), 0)
	dy := math.Max(math.Max(float64(s.Y)-p.Y, p.Y-float64(s.Y+s.Height)), 0)
	return math.Hypot(dx, dy)
}

func format(g *d2graph.Graph) string { return d2format.Format(g.AST) }

func movedID(e Edit) string { return joinID(e.To, baseName(e.Key)) }

func applyMove(source string, e Edit) (string, error) {
	g, err := compile(source)
	if err != nil {
		return "", err
	}
	if findObject(g, e.Key) == nil {
		return "", errUnknownShape(e.Key)
	}
	if within(e.To, e.Key) {
		return "", fmt.Errorf("cannot move %s into itself", e.Key)
	}
	if e.To != "" && findObject(g, e.To) == nil {
		return "", fmt.Errorf("unknown container %s", e.To)
	}
	target := movedID(e)
	if target == e.Key {
		return "", fmt.Errorf("%s is already there", e.Key)
	}
	if findObject(g, target) != nil {
		return "", fmt.Errorf("%s already exists", target)
	}
	if g, err = unpinOne(g, e.Key, false); err != nil {
		return "", err
	}
	if g, err = d2oracle.Move(g, nil, e.Key, target, true); err != nil {
		return "", err
	}
	return format(g), nil
}

func splitColumn(g *d2graph.Graph, to string) (*d2graph.Object, string) {
	if obj := findObject(g, to); obj != nil {
		return obj, ""
	}
	if obj := findObject(g, parentID(to)); obj != nil && obj.SQLTable != nil {
		return obj, baseName(to)
	}
	return nil, ""
}

func applyReconnect(source string, e Edit) (string, error) {
	g, err := compile(source)
	if err != nil {
		return "", err
	}
	if e.End != "src" && e.End != "dst" {
		return "", errors.New("end must be src or dst")
	}
	var edge *d2graph.Edge
	for _, c := range g.Edges {
		if c.AbsID() == e.Key {
			edge = c
		}
	}
	if edge == nil {
		return "", fmt.Errorf("unknown edge %s", e.Key)
	}
	target, _ := splitColumn(g, e.To)
	if target == nil {
		return "", errUnknownShape(e.To)
	}
	other := edge.Dst
	if e.End == "dst" {
		other = edge.Src
	}
	if other == target {
		return "", errors.New("edge would loop onto itself")
	}
	if direct := reconnectInPlace(g, edge, e); direct {
		kp, err := d2parser.ParseKey(e.To)
		if err != nil {
			return "", err
		}
		for _, ref := range edge.References {
			ends := ref.MapKey.Edges[ref.MapKeyEdgeIndex]
			if e.End == "src" {
				ends.Src = kp
			} else {
				ends.Dst = kp
			}
		}
		out := format(g)
		if _, err := compile(out); err != nil {
			return "", err
		}
		return out, nil
	}
	var src, dst *string
	if e.End == "src" {
		src = go2.Pointer(target.AbsID())
	} else {
		dst = go2.Pointer(target.AbsID())
	}
	if g, err = d2oracle.ReconnectEdge(g, nil, e.Key, src, dst); err != nil {
		return "", err
	}
	return format(g), nil
}

func reconnectInPlace(g *d2graph.Graph, edge *d2graph.Edge, e Edit) bool {
	if len(edge.References) == 0 {
		return false
	}
	for _, ref := range edge.References {
		if ref.ScopeObj != g.Root || len(ref.MapKey.Edges) != 1 {
			return false
		}
	}
	return true
}

func relativePin(shapes map[string]Shape, id string, left, top int) (int, int) {
	if parent, ok := shapes[parentID(id)]; ok {
		return max(left-parent.X-containerPad, 0), max(top-parent.Y-containerPad, 0)
	}
	return max(left, 0), max(top, 0)
}

func setFields(g *d2graph.Graph, id string, fields [][2]string) (*d2graph.Graph, error) {
	var err error
	for _, f := range fields {
		if g, err = d2oracle.Set(g, nil, id+"."+f[0], nil, go2.Pointer(f[1])); err != nil {
			return nil, fmt.Errorf("set %s.%s: %w", id, f[0], err)
		}
	}
	return g, nil
}

func pinSource(source string, ids []string, shapes map[string]Shape) (string, error) {
	g, err := compile(source)
	if err != nil {
		return "", err
	}
	for _, id := range ids {
		s, ok := shapes[id]
		if !ok {
			continue
		}
		left, top := relativePin(shapes, id, s.X, s.Y)
		fields := [][2]string{{"left", strconv.Itoa(left)}, {"top", strconv.Itoa(top)}}
		obj := findObject(g, id)
		if obj != nil && len(obj.ChildrenArray) == 0 && s.Type != "sql_table" {
			fields = append(fields, [2]string{"width", strconv.Itoa(s.Width)}, [2]string{"height", strconv.Itoa(s.Height)})
		}
		if obj != nil {
			fields = slices.DeleteFunc(fields, func(f [2]string) bool { return scalarIs(obj, f[0], f[1]) })
		}
		if g, err = setFields(g, id, fields); err != nil {
			return "", err
		}
	}
	return format(g), nil
}

func scalarIs(obj *d2graph.Object, name, value string) bool {
	var sc *d2graph.Scalar
	switch name {
	case "left":
		sc = obj.Left
	case "top":
		sc = obj.Top
	case "width":
		sc = obj.WidthAttr
	case "height":
		sc = obj.HeightAttr
	}
	return sc != nil && sc.Value == value
}

func sizedIn(source string) map[string]bool {
	sized := map[string]bool{}
	g, err := compile(source)
	if err != nil {
		return sized
	}
	for _, obj := range g.Objects {
		if obj.WidthAttr != nil || obj.HeightAttr != nil {
			sized[obj.AbsID()] = true
		}
	}
	return sized
}

func remapSized(sized map[string]bool, e Edit) map[string]bool {
	out := make(map[string]bool, len(sized))
	for id, v := range sized {
		if e.Kind == "move" && within(id, e.Key) {
			id = movedID(e) + id[len(e.Key):]
		}
		out[id] = v
	}
	return out
}

func unpinOne(g *d2graph.Graph, id string, keepSize bool) (*d2graph.Graph, error) {
	obj := findObject(g, id)
	if obj == nil {
		return nil, errUnknownShape(id)
	}
	var err error
	for _, f := range []struct {
		name string
		set  bool
	}{{"top", obj.Top != nil}, {"left", obj.Left != nil}, {"width", !keepSize && obj.Top != nil && obj.WidthAttr != nil}, {"height", !keepSize && obj.Top != nil && obj.HeightAttr != nil}} {
		if f.set {
			if g, err = d2oracle.Delete(g, nil, id+"."+f.name); err != nil {
				return nil, err
			}
		}
	}
	return g, nil
}

func unpinAll(source string, sized map[string]bool) (string, error) {
	g, err := compile(source)
	if err != nil {
		return "", err
	}
	var ids []string
	for _, obj := range g.Objects {
		if obj.Top != nil || obj.Left != nil {
			ids = append(ids, obj.AbsID())
		}
	}
	for _, id := range ids {
		if g, err = unpinOne(g, id, sized[id]); err != nil {
			return "", err
		}
	}
	return format(g), nil
}

func setDirection(source, id, value string) (string, error) {
	g, err := compile(source)
	if err != nil {
		return "", err
	}
	key := "direction"
	if id != "" {
		if findObject(g, id) == nil {
			return "", errUnknownShape(id)
		}
		key = id + ".direction"
	}
	if g, err = d2oracle.Set(g, nil, key, nil, go2.Pointer(value)); err != nil {
		return "", err
	}
	return format(g), nil
}

func unpinSingle(source, id string, sized map[string]bool) (string, error) {
	g, err := compile(source)
	if err != nil {
		return "", err
	}
	if g, err = unpinOne(g, id, sized[id]); err != nil {
		return "", err
	}
	return format(g), nil
}
