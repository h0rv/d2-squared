package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

type harness struct {
	t       *testing.T
	session *Session
	src     string
	orig    string
}

func newHarness(t *testing.T, path string) *harness {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{t: t, src: string(raw), orig: string(raw)}
	h.session = NewSession(func(source string) error {
		h.src = source
		return nil
	})
	if _, err := h.session.Open(h.src); err != nil {
		t.Fatal(err)
	}
	return h
}

func (h *harness) ctx() context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	h.t.Cleanup(cancel)
	return ctx
}

func (h *harness) view() View { return h.session.Snapshot() }

func (h *harness) commit(e Edit) (View, error) {
	_, v, err := h.session.Commit(h.ctx(), e, h.view().Version)
	return v, err
}

func (h *harness) mustCommit(e Edit) View {
	h.t.Helper()
	v, err := h.commit(e)
	if err != nil {
		h.t.Fatalf("commit %+v: %v", e, err)
	}
	return v
}

func (h *harness) shapes() map[string]Shape { return h.view().Layout.shapeMap() }

func (h *harness) noDrift() {
	h.t.Helper()
	d, err := h.session.Verify(h.ctx())
	if err != nil {
		h.t.Fatal(err)
	}
	if d.MaxDelta >= 2 {
		h.t.Fatalf("a fresh layout of the saved file differs from the view: %+v", d)
	}
}

func (h *harness) edgeID(src, dst string) string {
	h.t.Helper()
	for _, c := range h.view().Conns {
		if c.Src == src && c.Dst == dst {
			return c.ID
		}
	}
	h.t.Fatalf("no edge %s -> %s", src, dst)
	return ""
}

func near(a, b int) bool { return math.Abs(float64(a-b)) <= 1 }

func TestArch(t *testing.T) {
	h := newHarness(t, "testdata/arch.d2")
	v0 := h.view()
	if len(v0.Shapes) != 19 {
		t.Fatalf("shapes = %d, want 19", len(v0.Shapes))
	}
	old := h.shapes()

	v := h.mustCommit(Edit{Kind: "move", Key: "services.billing", To: "data"})
	block := regexp.MustCompile(`(?ms)^data: \{.*?^\}`).FindString(h.src)
	if !strings.Contains(block, "billing: Billing Service") {
		t.Fatalf("billing is not inside data:\n%s", h.src)
	}
	if !strings.Contains(h.src, "billing -> data.pg") && !strings.Contains(h.src, "data.billing -> data.pg") && !strings.Contains(h.src, "billing -> pg") {
		t.Fatalf("edges did not survive the move:\n%s", h.src)
	}
	cur := h.shapes()
	if !cur["data.billing"].Pinned || !cur["idp"].Pinned || !strings.Contains(h.src, "left:") {
		t.Fatal("moved shape and the others should be pinned")
	}
	if len(v.Changed) == 0 || !v.CanUndo {
		t.Fatal("commit should report changed lines and allow undo")
	}
	for _, id := range []string{"idp", "services.auth", "services.users"} {
		if math.Abs(float64(cur[id].X-old[id].X)) >= 2 || math.Abs(float64(cur[id].Y-old[id].Y)) >= 2 {
			t.Fatalf("%s moved: %+v -> %+v", id, old[id], cur[id])
		}
	}
	h.noDrift()

	h.mustCommit(Edit{Kind: "move", Key: "services.core", To: ""})
	if !regexp.MustCompile(`(?m)^core: `).MatchString(h.src) || !strings.Contains(h.src, "orders: Order Service") {
		t.Fatalf("container with children did not move to the top level:\n%s", h.src)
	}
	h.noDrift()

	if _, err := h.commit(Edit{Kind: "move", Key: "services", To: "services.auth"}); err == nil {
		t.Fatal("moving into a descendant should fail")
	}
	if _, err := h.commit(Edit{Kind: "move", Key: "data.pg", To: "data.pg"}); err == nil {
		t.Fatal("moving into itself should fail")
	}

	eid := h.edgeID("edge.web", "edge.gateway")
	h.mustCommit(Edit{Kind: "reconnect", Key: eid, End: "dst", To: "idp"})
	if !strings.Contains(h.src, "edge.web -> idp") {
		t.Fatalf("reconnect not written:\n%s", h.src)
	}
	d, _ := h.session.Verify(h.ctx())
	if d.Moved != 0 {
		t.Fatalf("reconnect moved %d nodes", d.Moved)
	}

	idp := h.shapes()["idp"]
	v = h.mustCommit(Edit{Kind: "pin", Key: "idp", Left: idp.X + 40, Top: idp.Y + 55})
	if s := v.Layout.shapeMap()["idp"]; s.X != idp.X+40 || s.Y != idp.Y+55 {
		t.Fatalf("pin landed at %d,%d", s.X, s.Y)
	}
	h.noDrift()

	pg := h.shapes()["data.pg"]
	v = h.mustCommit(Edit{Kind: "pin", Key: "data.pg", Left: pg.X + 30, Top: pg.Y + 20})
	got := v.Layout.shapeMap()
	if !near(got["data.pg"].X, pg.X+30) || !near(got["data.pg"].Y, pg.Y+20) {
		t.Fatalf("nested pin landed at %d,%d, want %d,%d", got["data.pg"].X, got["data.pg"].Y, pg.X+30, pg.Y+20)
	}
	h.noDrift()
	m := regexp.MustCompile(`(?s)pg: Postgres \{[^}]*left: (\d+)`).FindStringSubmatch(h.src)
	if m == nil {
		t.Fatalf("no nested pin written:\n%s", h.src)
	}
	rel := got["data.pg"].X - got["data"].X - containerPad
	if !near(atoi(m[1]), rel) {
		t.Fatalf("nested pin left = %s, want %d", m[1], rel)
	}

	h.mustCommit(Edit{Kind: "direction", Key: "services", To: "right"})
	if !strings.Contains(h.src, "direction: right") || strings.Contains(h.src, "left:") {
		t.Fatalf("direction should unpin everything:\n%s", h.src)
	}

	steps := 0
	for {
		if _, err := h.session.Undo(); err != nil {
			break
		}
		steps++
	}
	if steps < 6 || strings.TrimSpace(h.src) != strings.TrimSpace(h.orig) {
		t.Fatalf("undo went back %d steps and the file is not the original:\n%s", steps, h.src)
	}
	if _, err := h.session.Redo(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(regexp.MustCompile(`(?ms)^data: \{.*?^\}`).FindString(h.src), "billing: Billing Service") {
		t.Fatal("redo did not restore the move")
	}
	if _, err := h.session.Undo(); err != nil {
		t.Fatal(err)
	}

	h.mustCommit(Edit{Kind: "unpin"})
	if strings.Contains(h.src, "left:") {
		t.Fatal("unpin all left positions behind")
	}
}

func atoi(s string) int {
	n := 0
	for _, r := range s {
		n = n*10 + int(r-'0')
	}
	return n
}

func TestAgentEditKeepsPins(t *testing.T) {
	h := newHarness(t, "testdata/arch.d2")
	h.mustCommit(Edit{Kind: "move", Key: "services.billing", To: "data"})
	before := h.view()
	old := h.shapes()
	extra := `
data.audit: Audit Log {shape: cylinder}
data.metrics: Metrics {shape: cylinder}
services.core.reports: Reports
services.core.reports -> data.metrics
services.core.orders -> data.audit
`
	v, err := h.session.Reload(h.src + extra)
	if err != nil {
		t.Fatal(err)
	}
	if v.Version <= before.Version || v.Cause != "reload" {
		t.Fatalf("version %d cause %s", v.Version, v.Cause)
	}
	cur := v.Layout.shapeMap()
	for _, id := range []string{"data.audit", "data.metrics", "services.core.reports"} {
		if _, ok := cur[id]; !ok {
			t.Fatalf("%s missing", id)
		}
	}
	for id, o := range old {
		if n, ok := cur[id]; ok && (math.Abs(float64(o.X-n.X)) > 1 || math.Abs(float64(o.Y-n.Y)) > 1) {
			t.Errorf("%s moved after the agent edit", id)
		}
	}
	for _, id := range []string{"data.audit", "data.metrics", "services.core.reports"} {
		a := cur[id]
		for bid, b := range cur {
			if bid == id || within(bid, id) || within(id, bid) {
				continue
			}
			overlap := a.X < b.X+b.Width && b.X < a.X+a.Width && a.Y < b.Y+b.Height && b.Y < a.Y+a.Height
			if overlap {
				t.Errorf("%s overlaps %s", id, bid)
			}
		}
	}
	h.src = v.Source
	if _, err := h.session.Undo(); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(h.src, "Audit Log") {
		t.Fatal("undo should restore the file from before the agent edit")
	}
}

func TestReloadKeepsViewOnError(t *testing.T) {
	h := newHarness(t, "testdata/arch.d2")
	good := h.view()
	v, err := h.session.Reload("a: {")
	if err == nil || v.Error == "" || v.Cause != "error" {
		t.Fatalf("want an error view, got %+v %v", v.Cause, err)
	}
	if len(v.Shapes) != len(good.Shapes) {
		t.Fatal("the last good layout should stay on screen")
	}
}

func TestStaleVersionIsRejected(t *testing.T) {
	h := newHarness(t, "testdata/arch.d2")
	_, _, err := h.session.Commit(h.ctx(), Edit{Kind: "move", Key: "idp", To: "data"}, h.view().Version+7)
	if !errors.Is(err, ErrStale) {
		t.Fatalf("err = %v", err)
	}
	if _, err := h.session.Plan(Target{Kind: "node", ID: "idp"}, Point{}, 99); !errors.Is(err, ErrStale) {
		t.Fatalf("plan err = %v", err)
	}
}

func TestPlanNearestFirst(t *testing.T) {
	h := newHarness(t, "testdata/arch.d2")
	edits, err := h.session.Plan(Target{Kind: "node", ID: "idp"}, Point{}, 0)
	if err != nil || len(edits) == 0 {
		t.Fatalf("%v %d", err, len(edits))
	}
	for _, e := range edits {
		if e.Kind != "move" || e.Key != "idp" {
			t.Fatalf("unexpected edit %+v", e)
		}
	}
}

func TestLargeERD(t *testing.T) {
	h := newHarness(t, "testdata/erd-large.d2")
	s := h.shapes()
	if len(s) != 36 {
		t.Fatalf("tables = %d, want 36", len(s))
	}
	if len(s["orders"].Cols) == 0 || s["orders"].PK != 0 {
		t.Fatalf("orders columns: %+v", s["orders"])
	}
	edge := h.edgeID("order_items", "orders")
	c, err := h.session.Candidate(h.ctx(), Edit{Kind: "reconnect", Key: edge, End: "dst", To: "customers.id"}, 0)
	if err != nil || c.Landing.ID != "customers" {
		t.Fatalf("candidate %+v %v", c, err)
	}
	h.mustCommit(Edit{Kind: "reconnect", Key: edge, End: "dst", To: "customers.id"})
	if !strings.Contains(h.src, "order_items.order_id -> customers.id") {
		t.Fatalf("column was lost:\n%s", h.src)
	}
	if regexp.MustCompile(`(?m)^orders\.id$`).MatchString(h.src) {
		t.Fatal("reconnect left a stray line behind")
	}
	h.mustCommit(Edit{Kind: "reconnect", Key: h.edgeID("payments", "orders"), End: "dst", To: "invoices.issued_at"})
	if !strings.Contains(h.src, "payments.order_id -> invoices.issued_at") {
		t.Fatal("explicit column target not written")
	}
	edits, err := h.session.Plan(Target{Kind: "edgeEnd", Edge: h.edgeID("refunds", "payments"), End: "dst"}, Point{X: 800, Y: 800}, 0)
	if err != nil || len(edits) == 0 {
		t.Fatalf("plan %v %d", err, len(edits))
	}
	for _, e := range edits {
		if !regexp.MustCompile(`^[a-z_]+\.id$`).MatchString(e.To) {
			t.Fatalf("candidate should target the primary key column: %+v", e)
		}
	}
	t0 := h.shapes()["orders"]
	v := h.mustCommit(Edit{Kind: "pin", Key: "orders", Left: t0.X + 100, Top: t0.Y + 50})
	if !near(v.Layout.shapeMap()["orders"].X, t0.X+100) {
		t.Fatal("pin missed")
	}
	h.noDrift()
}

func TestSizedKeepsUserSizes(t *testing.T) {
	h := newHarness(t, "testdata/sized.d2")
	a := h.shapes()["c"]
	h.mustCommit(Edit{Kind: "pin", Key: "c", Left: a.X + 40, Top: a.Y + 30})
	if strings.Count(h.src, "width:") < 3 {
		t.Fatalf("pin should write widths for shapes without one:\n%s", h.src)
	}
	h.mustCommit(Edit{Kind: "unpin"})
	if !strings.Contains(h.src, "width: 222") || !strings.Contains(h.src, "height: 90") {
		t.Fatalf("unpin all dropped the user size:\n%s", h.src)
	}
	if strings.Count(h.src, "width:") != 1 || strings.Count(h.src, "height:") != 1 || strings.Contains(h.src, "left:") {
		t.Fatalf("unpin all kept editor sizes:\n%s", h.src)
	}
	h.mustCommit(Edit{Kind: "pin", Key: "a", Left: 300, Top: 20})
	h.mustCommit(Edit{Kind: "unpin", Key: "a"})
	if !strings.Contains(h.src, "width: 222") {
		t.Fatalf("unpin one dropped the user size:\n%s", h.src)
	}
}

func sceneText(l *Layout) string {
	var b strings.Builder
	b.WriteString(l.Scene.CSS + l.Scene.Defs)
	for _, p := range l.Scene.Shapes {
		b.WriteString(p.SVG)
	}
	for _, p := range l.Scene.Conns {
		b.WriteString(p.SVG)
	}
	return b.String()
}

func TestSceneIsSplitAndStable(t *testing.T) {
	h := newHarness(t, "testdata/arch.d2")
	l := h.view().Layout
	text := sceneText(l)
	if !strings.Contains(text, stableHash) {
		t.Fatal("the scene should carry the stable hash")
	}
	if len(l.Scene.Shapes) != len(l.Shapes) || len(l.Scene.Conns) != len(l.Conns) {
		t.Fatalf("every shape and connection needs a piece: %d/%d shapes, %d/%d connections",
			len(l.Scene.Shapes), len(l.Shapes), len(l.Scene.Conns), len(l.Conns))
	}
	if strings.Contains(text, `mask="url(#`+stableHash+`)"`) || strings.Contains(l.Scene.Defs, "<mask") {
		t.Fatal("the shared mask should be gone")
	}
	if strings.Count(l.Scene.Defs, "<marker") == 0 || strings.Contains(connText(l), "<marker") {
		t.Fatal("markers should be hoisted into the shared defs")
	}
	if !strings.Contains(connText(l), `<g class="label">`) {
		t.Fatal("a labelled connection should keep its label in its own group")
	}
	h2 := newHarness(t, "testdata/arch.d2")
	if sceneText(h2.view().Layout) != text {
		t.Fatal("the same source should render the same scene")
	}
}

func connText(l *Layout) string {
	var b strings.Builder
	for _, p := range l.Scene.Conns {
		b.WriteString(p.SVG)
	}
	return b.String()
}

func TestSceneCoversEveryExample(t *testing.T) {
	files, _ := filepath.Glob("../examples/*.d2")
	more, _ := filepath.Glob("testdata/*.d2")
	for _, f := range append(files, more...) {
		h := newHarness(t, f)
		l := h.view().Layout
		if len(l.Scene.Shapes) != len(l.Shapes) || len(l.Scene.Conns) != len(l.Conns) {
			t.Fatalf("%s: pieces do not match the diagram", f)
		}
	}
}

func hasNull(t *testing.T, name string, v any) {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var tree any
	if err := json.Unmarshal(raw, &tree); err != nil {
		t.Fatal(err)
	}
	var walk func(path string, n any)
	walk = func(path string, n any) {
		switch n := n.(type) {
		case nil:
			t.Errorf("%s: null at %s", name, path)
		case map[string]any:
			for k, c := range n {
				walk(path+"."+k, c)
			}
		case []any:
			for i, c := range n {
				walk(fmt.Sprintf("%s[%d]", path, i), c)
			}
		}
	}
	walk("", tree)
}

func TestNoNullListsInTheAPI(t *testing.T) {
	h := newHarness(t, "testdata/arch.d2")
	v := h.view()
	hasNull(t, "view", v)
	edgeEnd, err := h.session.Route(Target{Kind: "edgeEnd", Edge: h.view().Conns[0].ID, End: "dst"}, Point{X: 10, Y: 10}, v.Version)
	if err != nil {
		t.Fatal(err)
	}
	hasNull(t, "arrow-end route", map[string]any{"paths": edgeEnd})
	lonely, err := h.session.Route(Target{Kind: "node", ID: "idp"}, Point{X: 0.1, Y: 0}, v.Version)
	if err != nil {
		t.Fatal(err)
	}
	hasNull(t, "node route", map[string]any{"paths": lonely})
	for _, id := range []string{"idp", "services.billing", "edge"} {
		moved, err := h.session.Route(Target{Kind: "node", ID: id}, Point{X: 30, Y: 30}, v.Version)
		if err != nil {
			t.Fatal(err)
		}
		hasNull(t, "route "+id, map[string]any{"paths": moved})
	}
	edits, err := h.session.Plan(Target{Kind: "node", ID: "services.billing"}, Point{X: 600, Y: 1200}, v.Version)
	if err != nil {
		t.Fatal(err)
	}
	hasNull(t, "plan", edits)
	ch, err := h.session.Preview(h.ctx(), Target{Kind: "node", ID: "services.billing"}, Point{X: 600, Y: 1200}, v.Version)
	if err != nil {
		t.Fatal(err)
	}
	seen := 0
	for c := range ch {
		seen++
		hasNull(t, "candidate "+c.Key, c)
	}
	if seen == 0 {
		t.Fatal("expected preview candidates")
	}
	hasNull(t, "committed view", h.mustCommit(Edit{Kind: "pin", Key: "idp", Left: 5, Top: 5}))
	hasNull(t, "undone view", func() View { u, _ := h.session.Undo(); return u }())
}

func TestDiffLines(t *testing.T) {
	d := diffLines("a\nb\nc\n", "a\nx\nc\n", 1)
	var ops []string
	for _, l := range d {
		ops = append(ops, l.Op+l.Text)
	}
	if strings.Join(ops, "|") != " a|+x|-b| c" {
		t.Fatalf("%v", ops)
	}
	if got := addedLines("a\nb\n", "a\nb\nc\n"); len(got) != 1 || got[0] != 3 {
		t.Fatalf("%v", got)
	}
}

func TestExamplesOpen(t *testing.T) {
	files, err := filepath.Glob("../examples/*.d2")
	if err != nil || len(files) != 5 {
		t.Fatalf("%v %v", files, err)
	}
	for _, f := range files {
		t.Run(filepath.Base(f), func(t *testing.T) {
			h := newHarness(t, f)
			if len(h.view().Shapes) < 5 {
				t.Fatal("too few shapes")
			}
		})
	}
}

func TestSignatureDrags(t *testing.T) {
	t.Run("family", func(t *testing.T) {
		h := newHarness(t, "../examples/family.d2")
		h.mustCommit(Edit{Kind: "move", Key: "rose.ben.max", To: "rose.cora"})
		if !strings.Contains(h.src, "max: Max") || !h.shapes()["rose.cora.max"].Pinned {
			t.Fatalf("max did not move under cora:\n%s", h.src)
		}
		h.noDrift()
	})
	t.Run("erd", func(t *testing.T) {
		h := newHarness(t, "../examples/erd.d2")
		h.mustCommit(Edit{Kind: "reconnect", Key: h.edgeID("reviews", "customers"), End: "dst", To: "orders.id"})
		if !strings.Contains(h.src, "reviews.customer_id -> orders.id") {
			t.Fatalf("column was lost:\n%s", h.src)
		}
	})
	t.Run("architecture", func(t *testing.T) {
		h := newHarness(t, "../examples/architecture.d2")
		h.mustCommit(Edit{Kind: "move", Key: "services.billing", To: "data"})
		if !h.shapes()["data.billing"].Pinned {
			t.Fatalf("billing did not move into data:\n%s", h.src)
		}
		h.noDrift()
	})
	t.Run("org", func(t *testing.T) {
		h := newHarness(t, "../examples/org.d2")
		h.mustCommit(Edit{Kind: "reconnect", Key: h.edgeID("eng1", "dev2"), End: "src", To: "eng2"})
		if !strings.Contains(h.src, "eng2 -> dev2") {
			t.Fatalf("dev2 did not get a new manager:\n%s", h.src)
		}
	})
	t.Run("states", func(t *testing.T) {
		h := newHarness(t, "../examples/order-states.d2")
		h.mustCommit(Edit{Kind: "reconnect", Key: h.edgeID("placed", "cancelled"), End: "dst", To: "refunded"})
		if !strings.Contains(h.src, "placed -> refunded: cancel") {
			t.Fatalf("transition not rewired:\n%s", h.src)
		}
	})
}

func directPins(t *testing.T, source, parent string) map[string][2]int {
	t.Helper()
	g, err := compile(source)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string][2]int{}
	for _, o := range g.Objects {
		if parentID(o.AbsID()) == parent && o.Left != nil && o.Top != nil {
			out[o.AbsID()] = [2]int{atoi(o.Left.Value), atoi(o.Top.Value)}
		}
	}
	return out
}

func minPin(pins map[string][2]int) (int, int) {
	l, tp := math.MaxInt, math.MaxInt
	for _, p := range pins {
		l, tp = min(l, p[0]), min(tp, p[1])
	}
	return l, tp
}

func TestGroupsHugTheirChildren(t *testing.T) {
	h := newHarness(t, "testdata/arch.d2")
	before := h.shapes()
	services := before["services"]
	notifier := before["services.notifier"]
	v := h.mustCommit(Edit{Kind: "pin", Key: "services.notifier",
		Left: services.X + services.Width - notifier.Width - containerPad, Top: notifier.Y})
	pins := directPins(t, h.src, "services")
	if len(pins) < 5 {
		t.Fatalf("every child of services should be pinned:\n%s", h.src)
	}
	if l, top := minPin(pins); l != 0 || top != 0 {
		t.Fatalf("children should start at the inner padding, got min left %d top %d:\n%s", l, top, h.src)
	}
	after := v.Layout.shapeMap()
	if after["services"].Width >= services.Width {
		t.Fatalf("services should shrink: %d -> %d", services.Width, after["services"].Width)
	}
	if after["services"].X != services.X || after["services"].Y != services.Y {
		t.Fatalf("services moved: %+v -> %+v", services, after["services"])
	}
	for _, id := range []string{"idp", "data", "edge"} {
		if after[id].X != before[id].X || after[id].Y != before[id].Y {
			t.Fatalf("%s moved: %+v -> %+v", id, before[id], after[id])
		}
	}
	h.noDrift()
}

func TestPreviewMatchesTheCommitWhenGroupsHug(t *testing.T) {
	h := newHarness(t, "testdata/arch.d2")
	services := h.shapes()["services"]
	notifier := h.shapes()["services.notifier"]
	e := Edit{Kind: "pin", Key: "services.notifier", Left: services.X + services.Width - notifier.Width - containerPad, Top: notifier.Y}
	c, err := h.session.Candidate(h.ctx(), e, h.view().Version)
	if err != nil {
		t.Fatal(err)
	}
	v := h.mustCommit(e)
	a, b := c.layout.shapeMap()["services"], v.Layout.shapeMap()["services"]
	if a.X != b.X || a.Y != b.Y || a.Width != b.Width || a.Height != b.Height || c.source != h.src {
		t.Fatal("the preview should equal the result")
	}
}

func TestTidyUpALayoutGroup(t *testing.T) {
	h := newHarness(t, "testdata/arch.d2")
	start := h.src
	b := h.shapes()["services.billing"]
	h.mustCommit(Edit{Kind: "pin", Key: "services.billing", Left: b.X + 200, Top: b.Y + 40})
	pinned := h.src
	outside := h.shapes()
	v := h.mustCommit(Edit{Kind: "tidy", Key: "services"})
	if got := directPins(t, h.src, "services"); len(got) != 0 {
		t.Fatalf("tidy should drop the saved positions inside the group:\n%s", h.src)
	}
	for _, id := range []string{"idp", "data", "edge", "services"} {
		s := v.Layout.shapeMap()[id]
		if s.X != outside[id].X || s.Y != outside[id].Y {
			t.Fatalf("%s moved: %+v -> %+v", id, outside[id], s)
		}
	}
	h.noDrift()
	u, err := h.session.Undo()
	if err != nil || h.src != pinned || u.Source != pinned {
		t.Fatalf("undo should restore the file: %v", err)
	}
	if h.src == start {
		t.Fatal("the setup should have pinned something")
	}
}

func TestResizeWritesWidthAndHeight(t *testing.T) {
	h := newHarness(t, "testdata/arch.d2")
	start := h.src
	a := h.shapes()["services.auth"]
	v := h.mustCommit(Edit{Kind: "resize", Key: "services.auth", Left: a.X, Top: a.Y, Width: a.Width + 70, Height: a.Height + 30})
	got := v.Layout.shapeMap()["services.auth"]
	if got.Width != a.Width+70 || got.Height != a.Height+30 {
		t.Fatalf("auth is %dx%d, want %dx%d", got.Width, got.Height, a.Width+70, a.Height+30)
	}
	if !strings.Contains(h.src, fmt.Sprintf("width: %d", a.Width+70)) || !strings.Contains(h.src, fmt.Sprintf("height: %d", a.Height+30)) {
		t.Fatalf("size not written:\n%s", h.src)
	}
	h.noDrift()
	if _, err := h.session.Undo(); err != nil || h.src != start {
		t.Fatalf("undo should restore the file: %v", err)
	}
}

func TestResizedGroupsKeepTheirSize(t *testing.T) {
	h := newHarness(t, "testdata/arch.d2")
	s := h.shapes()["services"]
	v := h.mustCommit(Edit{Kind: "resize", Key: "services", Left: s.X, Top: s.Y, Width: s.Width + 120, Height: s.Height + 80})
	got := v.Layout.shapeMap()["services"]
	if got.Width != s.Width+120 || got.Height != s.Height+80 {
		t.Fatalf("services is %dx%d, want %dx%d:\n%s", got.Width, got.Height, s.Width+120, s.Height+80, h.src)
	}
	b := h.shapes()["services.billing"]
	h.mustCommit(Edit{Kind: "pin", Key: "services.billing", Left: b.X + 30, Top: b.Y})
	if again := h.shapes()["services"]; again.Width != got.Width || again.Height != got.Height {
		t.Fatalf("a resized group should keep its size: %+v -> %+v", got, again)
	}
}

func skewedRoutes(l *Layout) []string {
	var bad []string
	for _, c := range l.Conns {
		for i := 1; i < len(c.Route); i++ {
			a, b := c.Route[i-1], c.Route[i]
			if math.Abs(a[0]-b[0]) > 1 && math.Abs(a[1]-b[1]) > 1 {
				bad = append(bad, c.ID)
				break
			}
		}
	}
	return bad
}

func TestRoutesStayOrthogonalAfterHugging(t *testing.T) {
	h := newHarness(t, "../examples/architecture.d2")
	v := h.mustCommit(Edit{Kind: "move", Key: "services.billing", To: "data"})
	if bad := skewedRoutes(v.Layout); len(bad) != 0 {
		t.Fatalf("diagonal arrows after the move: %v", bad)
	}
	files, _ := filepath.Glob("../examples/*.d2")
	for _, f := range files {
		if bad := skewedRoutes(newHarness(t, f).view().Layout); len(bad) != 0 {
			t.Fatalf("%s has diagonal arrows: %v", f, bad)
		}
	}
}
