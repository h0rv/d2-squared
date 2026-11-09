package engine

import (
	"encoding/base64"
	"fmt"
	"html"
	"regexp"
	"strconv"
	"strings"

	xhtml "golang.org/x/net/html"
)

type Piece struct {
	ID  string `json:"id"`
	SVG string `json:"svg"`
}

type Scene struct {
	CSS    string  `json:"css"`
	Defs   string  `json:"defs"`
	Shapes []Piece `json:"shapes"`
	Conns  []Piece `json:"connections"`
}

var voidTags = map[string]bool{"br": true, "img": true, "hr": true, "input": true, "meta": true, "link": true}

func parts(s string) []string {
	z := xhtml.NewTokenizer(strings.NewReader(s))
	out := []string{}
	var cur strings.Builder
	depth := 0
	for {
		tt := z.Next()
		if tt == xhtml.ErrorToken {
			break
		}
		cur.Write(z.Raw())
		switch tt {
		case xhtml.StartTagToken:
			if name, _ := z.TagName(); !voidTags[string(name)] {
				depth++
			}
		case xhtml.EndTagToken:
			depth--
		}
		if depth == 0 {
			if node := cur.String(); strings.TrimSpace(node) != "" {
				out = append(out, node)
			}
			cur.Reset()
		}
	}
	return out
}

func unwrap(el string) string {
	start := strings.Index(el, ">") + 1
	end := strings.LastIndex(el, "</")
	if start <= 0 || end < start {
		return ""
	}
	return el[start:end]
}

var (
	attrRe   = regexp.MustCompile(`([\w:-]+)="([^"]*)"`)
	classRe  = regexp.MustCompile(`^<g class="([^"]*)"`)
	markerRe = regexp.MustCompile(`^<marker id="([^"]*)"`)
	maskRef  = regexp.MustCompile(` mask="url\(#[^)]*\)"`)
)

func attrs(el string) map[string]string {
	tag := el[:strings.Index(el, ">")+1]
	m := map[string]string{}
	for _, a := range attrRe.FindAllStringSubmatch(tag, -1) {
		m[a[1]] = a[2]
	}
	return m
}

func num(m map[string]string, k string) float64 {
	v, _ := strconv.ParseFloat(m[k], 64)
	return v
}

func pieceID(el string) string {
	m := classRe.FindStringSubmatch(el)
	if m == nil {
		return ""
	}
	raw, err := base64.StdEncoding.DecodeString(m[1])
	if err != nil {
		return ""
	}
	return html.UnescapeString(string(raw))
}

type hole struct{ x, y, w, h float64 }

func holes(mask string) []hole {
	var out []hole
	for i, r := range parts(unwrap(mask)) {
		if i == 0 {
			continue
		}
		a := attrs(r)
		out = append(out, hole{num(a, "x"), num(a, "y"), num(a, "width"), num(a, "height")})
	}
	return out
}

func tagName(el string) string {
	end := strings.IndexAny(el, " />\t\n")
	if !strings.HasPrefix(el, "<") || end < 0 {
		return ""
	}
	return el[1:end]
}

func connectionPiece(id, el string, holeList []hole, n int, markers map[string]string, order *[]string) string {
	var body, label, cuts strings.Builder
	maskID := fmt.Sprintf("d2squared-m%d", n)
	for _, kid := range parts(unwrap(el)) {
		switch tagName(kid) {
		case "marker":
			if m := markerRe.FindStringSubmatch(kid); m != nil {
				if _, ok := markers[m[1]]; !ok {
					*order = append(*order, m[1])
				}
				markers[m[1]] = kid
			}
		case "path":
			body.WriteString(kid)
		default:
			label.WriteString(kid)
			a := attrs(kid)
			tx, ty := num(a, "x"), num(a, "y")
			for _, h := range holeList {
				if tx >= h.x && tx <= h.x+h.w && ty >= h.y && ty <= h.y+h.h {
					fmt.Fprintf(&cuts, `<rect x="%g" y="%g" width="%g" height="%g" fill="rgba(0,0,0,0.75)"></rect>`, h.x, h.y, h.w, h.h)
				}
			}
		}
	}
	path := maskRef.ReplaceAllString(body.String(), "")
	var out strings.Builder
	head := el[:strings.Index(el, ">")+1]
	out.WriteString(head)
	if cuts.Len() > 0 {
		path = strings.Replace(path, "<path ", `<path mask="url(#`+maskID+`)" `, 1)
		fmt.Fprintf(&out, `<mask id="%s" maskUnits="userSpaceOnUse" x="-100000" y="-100000" width="200000" height="200000"><rect x="-100000" y="-100000" width="200000" height="200000" fill="white"></rect><g class="hole">%s</g></mask>`, maskID, cuts.String())
	}
	out.WriteString(path)
	if label.Len() > 0 {
		fmt.Fprintf(&out, `<g class="label">%s</g>`, label.String())
	}
	out.WriteString("</g>")
	return out.String()
}

func splitScene(svg string, shapeIDs, connIDs map[string]bool) Scene {
	scene := Scene{Shapes: []Piece{}, Conns: []Piece{}}
	var inner string
	for _, kid := range parts(unwrap(svg)) {
		if tagName(kid) == "svg" {
			inner = unwrap(kid)
		}
	}
	var css strings.Builder
	var defs strings.Builder
	var holeList []hole
	markers := map[string]string{}
	var markerOrder []string
	var conns []Piece
	kids := parts(inner)
	for _, kid := range kids {
		if tagName(kid) == "mask" {
			holeList = holes(kid)
		}
	}
	n := 0
	for _, kid := range kids {
		switch tagName(kid) {
		case "rect", "mask":
		case "style":
			body := strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(unwrap(kid)), "<![CDATA["), "]]>")
			css.WriteString(body)
			css.WriteString("\n")
		case "g":
			id := pieceID(kid)
			switch {
			case shapeIDs[id]:
				scene.Shapes = append(scene.Shapes, Piece{ID: id, SVG: kid})
			case connIDs[id]:
				conns = append(conns, Piece{ID: id, SVG: connectionPiece(id, kid, holeList, n, markers, &markerOrder)})
				n++
			}
		default:
			defs.WriteString(kid)
		}
	}
	scene.Conns = append(scene.Conns, conns...)
	for _, id := range markerOrder {
		defs.WriteString(markers[id])
	}
	scene.CSS = css.String()
	scene.Defs = defs.String()
	return scene
}
