package engine

import "strings"

type DiffLine struct {
	Op   string `json:"op"`
	Text string `json:"text"`
}

func splitLines(s string) []string {
	return strings.Split(strings.TrimRight(s, "\n"), "\n")
}

type edit struct {
	op   byte
	a, b int
}

func lineEdits(a, b []string) []edit {
	start := 0
	for start < len(a) && start < len(b) && a[start] == b[start] {
		start++
	}
	endA, endB := len(a), len(b)
	for endA > start && endB > start && a[endA-1] == b[endB-1] {
		endA--
		endB--
	}
	ma, mb := a[start:endA], b[start:endB]
	n, m := len(ma), len(mb)
	table := make([][]int32, n+1)
	for i := range table {
		table[i] = make([]int32, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if ma[i] == mb[j] {
				table[i][j] = table[i+1][j+1] + 1
			} else {
				table[i][j] = max(table[i+1][j], table[i][j+1])
			}
		}
	}
	var out []edit
	for i := 0; i < start; i++ {
		out = append(out, edit{' ', i, i})
	}
	i, j := 0, 0
	for i < n || j < m {
		switch {
		case i < n && j < m && ma[i] == mb[j]:
			out = append(out, edit{' ', start + i, start + j})
			i++
			j++
		case j < m && (i == n || table[i][j+1] >= table[i+1][j]):
			out = append(out, edit{'+', -1, start + j})
			j++
		default:
			out = append(out, edit{'-', start + i, -1})
			i++
		}
	}
	for k := 0; endA+k < len(a); k++ {
		out = append(out, edit{' ', endA + k, endB + k})
	}
	return out
}

func diffLines(oldSrc, newSrc string, context int) []DiffLine {
	a, b := splitLines(oldSrc), splitLines(newSrc)
	edits := lineEdits(a, b)
	keep := make([]bool, len(edits))
	for i, e := range edits {
		if e.op == ' ' {
			continue
		}
		for k := max(i-context, 0); k <= min(i+context, len(edits)-1); k++ {
			keep[k] = true
		}
	}
	var out []DiffLine
	skipped := false
	for i, e := range edits {
		if !keep[i] {
			skipped = true
			continue
		}
		if skipped && len(out) > 0 {
			out = append(out, DiffLine{Op: "…"})
		}
		skipped = false
		switch e.op {
		case '+':
			out = append(out, DiffLine{Op: "+", Text: b[e.b]})
		case '-':
			out = append(out, DiffLine{Op: "-", Text: a[e.a]})
		default:
			out = append(out, DiffLine{Op: " ", Text: b[e.b]})
		}
	}
	return out
}

func addedLines(oldSrc, newSrc string) []int {
	var lines []int
	for _, e := range lineEdits(splitLines(oldSrc), splitLines(newSrc)) {
		if e.op == '+' {
			lines = append(lines, e.b+1)
		}
	}
	return lines
}

func countAdded(oldSrc, newSrc string) int {
	return len(addedLines(oldSrc, newSrc))
}
