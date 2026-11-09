package engine

import (
	"context"
	"errors"
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

func TestStableSVGHash(t *testing.T) {
	h := newHarness(t, "testdata/arch.d2")
	svg := h.view().SVG
	if !strings.Contains(svg, stableHash) {
		t.Fatal("svg should carry the stable hash")
	}
	h2 := newHarness(t, "testdata/arch.d2")
	if h2.view().SVG != svg {
		t.Fatal("the same source should render the same svg")
	}
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
