// Command extract emits the RippleWitness static graph JSON for a Go subject
// tree — the same schema as the ts-morph and Python extractors.
//
// Usage: extract <appRoot>
//
// Coverage: stdlib net/http registration (HandleFunc/Handle on any receiver,
// including ServeMux; Go 1.22 "METHOD /path" patterns, {param} normalized to
// :param), name-based call resolution to depth 3, SQL table regex on string
// literals (Exec→writes, else reads), os.Getenv/LookupEnv config reads.
// Deterministic: same tree → same bytes.
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var (
	sqlTableRe = regexp.MustCompile(`(?i)\b(?:FROM|JOIN|INTO|UPDATE)\s+["'\x60\[]?([A-Za-z_][\w]*)`)
	paramRe    = regexp.MustCompile(`\{([A-Za-z_][\w]*)\}`)
	skipDirs   = map[string]bool{".git": true, "vendor": true, "node_modules": true, "testdata": true}
	skipCalls  = map[string]bool{
		"len": true, "cap": true, "append": true, "copy": true, "delete": true,
		"panic": true, "recover": true, "print": true, "println": true,
		"Error": true, "Errorf": true, "Sprintf": true, "Printf": true, "Println": true,
		"Marshal": true, "Unmarshal": true, "New": true, "Close": true,
	}
)

type funcFacts struct {
	rel   string
	qual  string
	start int
	end   int
	node  *ast.FuncDecl
}

type routeHit struct {
	method  string
	path    string
	qual    string
	rel     string
	handler *ast.FuncDecl // nil for anonymous
	line    int
	end     int
}

type node struct {
	ID    string  `json:"id"`
	Kind  string  `json:"kind"`
	Label string  `json:"label"`
	File  string  `json:"file,omitempty"`
	Range *[2]int `json:"range,omitempty"`
}

type edge struct {
	From       string `json:"from"`
	To         string `json:"to"`
	Type       string `json:"type"`
	Confidence string `json:"confidence"`
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: extract <appRoot>")
		os.Exit(2)
	}
	g, err := extract(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
	out, _ := json.Marshal(g)
	fmt.Println(string(out))
}

func goFiles(root string) ([]string, error) {
	var out []string
	err := filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() {
			base := filepath.Base(p)
			if skipDirs[base] || strings.HasPrefix(base, ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
			return nil
		}
		out = append(out, p)
		return nil
	})
	sort.Strings(out)
	return out, err
}

func strLit(e ast.Expr) (string, bool) {
	lit, ok := e.(*ast.BasicLit)
	if !ok || lit.Kind.String() != "STRING" {
		return "", false
	}
	s := lit.Value
	if len(s) >= 2 {
		if s[0] == '"' {
			var v string
			if _, err := fmt.Sscanf(s, "%q", &v); err == nil {
				return v, true
			}
			return s[1 : len(s)-1], true
		}
		if s[0] == '`' {
			return s[1 : len(s)-1], true
		}
	}
	return "", false
}

func normalizeParam(p string) string { return paramRe.ReplaceAllString(p, ":$1") }

type graph struct {
	funcs  map[string]*funcFacts // rel + "\x00" + qual
	byName map[string][]*funcFacts
	nodes  map[string]node
	edges  map[edge]bool
	fset   *token.FileSet
}

func (g *graph) addNode(id, kind, label, file string, r *[2]int) {
	if _, ok := g.nodes[id]; ok {
		return
	}
	n := node{ID: id, Kind: kind, Label: label}
	if file != "" {
		n.File = file
	}
	if r != nil {
		n.Range = r
	}
	g.nodes[id] = n
}

func fnID(rel, qual string) string { return "fn:" + rel + ":" + qual }

// resolveCall maps a call to declaring func facts, name-based like the others.
func (g *graph) resolveCall(rel string, call *ast.CallExpr) *funcFacts {
	switch fn := call.Fun.(type) {
	case *ast.Ident:
		if skipCalls[fn.Name] {
			return nil
		}
		for _, f := range g.funcs {
			if f.rel == rel && f.qual == fn.Name {
				return f
			}
		}
		cands := g.byName[fn.Name]
		if len(cands) == 1 {
			return cands[0]
		}
		return nil
	case *ast.SelectorExpr:
		name := fn.Sel.Name
		if skipCalls[name] {
			return nil
		}
		cands := g.byName[name]
		if len(cands) == 1 {
			return cands[0]
		}
		return nil
	}
	return nil
}

func (g *graph) scan(f *funcFacts, depth int, stack map[string]bool) {
	src := fnID(f.rel, f.qual)
	pos := g.fset.Position(f.node.Pos())
	end := g.fset.Position(f.node.End())
	g.addNode(src, "service", f.qual, f.rel, &[2]int{pos.Line, end.Line})
	if stack[src] {
		return
	}
	stack[src] = true
	defer delete(stack, src)
	ast.Inspect(f.node.Body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		// os.Getenv("X") / os.LookupEnv("X") config reads.
		if sel, ok := call.Fun.(*ast.SelectorExpr); ok {
			if id, ok := sel.X.(*ast.Ident); ok && id.Name == "os" && (sel.Sel.Name == "Getenv" || sel.Sel.Name == "LookupEnv") && len(call.Args) > 0 {
				if key, ok := strLit(call.Args[0]); ok {
					cid := "config:env:" + key
					g.addNode(cid, "config", "env:"+key, "", nil)
					g.edges[edge{src, cid, "config", "EXTRACTED"}] = true
				}
			}
		}
		// SQL table regex on string literal args.
		for _, a := range call.Args {
			if s, ok := strLit(a); ok {
				for _, m := range sqlTableRe.FindAllStringSubmatch(s, -1) {
					tid := "db:" + m[1]
					g.addNode(tid, "db_table", m[1], "", nil)
					typ := "reads"
					if sel, ok := call.Fun.(*ast.SelectorExpr); ok && sel.Sel.Name == "Exec" {
						typ = "writes"
					}
					g.edges[edge{src, tid, typ, "EXTRACTED"}] = true
				}
			}
		}
		if target := g.resolveCall(f.rel, call); target != nil {
			dst := fnID(target.rel, target.qual)
			g.edges[edge{src, dst, "calls", "EXTRACTED"}] = true
			if depth < 3 {
				g.scan(target, depth+1, stack)
			}
		}
		return true
	})
}

func extract(root string) (map[string]any, error) {
	files, err := goFiles(root)
	if err != nil {
		return nil, err
	}
	g := &graph{funcs: map[string]*funcFacts{}, byName: map[string][]*funcFacts{}, nodes: map[string]node{}, edges: map[edge]bool{}, fset: token.NewFileSet()}
	type parsed struct {
		rel string
		f   *ast.File
	}
	var parsedFiles []parsed
	for _, p := range files {
		f, err := parser.ParseFile(g.fset, p, nil, 0)
		if err != nil {
			continue // unparseable file: skip, like the other extractors
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		parsedFiles = append(parsedFiles, parsed{rel, f})
		for _, d := range f.Decls {
			fn, ok := d.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			qual := fn.Name.Name
			if fn.Recv != nil && len(fn.Recv.List) > 0 {
				t := fn.Recv.List[0].Type
				if star, ok := t.(*ast.StarExpr); ok {
					t = star.X
				}
				if id, ok := t.(*ast.Ident); ok {
					qual = id.Name + "." + fn.Name.Name
				}
			}
			ff := &funcFacts{rel: rel, qual: qual, node: fn}
			g.funcs[rel+"\x00"+qual] = ff
			short := fn.Name.Name
			g.byName[short] = append(g.byName[short], ff)
		}
	}
	// Routes: X.HandleFunc("pattern", h) / X.Handle("pattern", h).
	var routes []routeHit
	for _, pf := range parsedFiles {
		ast.Inspect(pf.f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok || len(call.Args) < 2 {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || (sel.Sel.Name != "HandleFunc" && sel.Sel.Name != "Handle") {
				return true
			}
			pattern, ok := strLit(call.Args[0])
			if !ok {
				return true
			}
			method, path := "ANY", pattern
			if i := strings.Index(pattern, " "); i > 0 {
				method, path = strings.ToUpper(pattern[:i]), pattern[i+1:]
			}
			pos := g.fset.Position(call.Pos())
			switch h := call.Args[1].(type) {
			case *ast.Ident:
				routes = append(routes, routeHit{method, normalizeParam(path), h.Name, pf.rel, nil, pos.Line, pos.Line})
			case *ast.CallExpr:
				// Handler constructor: handleB(db) — attribute to the constructor;
				// its body (including closures) is scanned like any other func.
				if id, ok := h.Fun.(*ast.Ident); ok {
					routes = append(routes, routeHit{method, normalizeParam(path), id.Name, pf.rel, nil, pos.Line, pos.Line})
				} else if sel, ok := h.Fun.(*ast.SelectorExpr); ok {
					routes = append(routes, routeHit{method, normalizeParam(path), sel.Sel.Name, pf.rel, nil, pos.Line, pos.Line})
				}
			case *ast.FuncLit:
				end := g.fset.Position(call.End())
				routes = append(routes, routeHit{method, normalizeParam(path), fmt.Sprintf("anon%d", pos.Line), pf.rel, nil, pos.Line, end.Line})
			}
			return true
		})
	}
	for _, r := range routes {
		rid := "route:" + r.method + " " + r.path
		g.addNode(rid, "route", r.path, r.rel, &[2]int{r.line, r.end})
		hid := fnID(r.rel, r.qual)
		if f := g.funcs[r.rel+"\x00"+r.qual]; f != nil {
			g.edges[edge{rid, hid, "calls", "EXTRACTED"}] = true
			g.scan(f, 1, map[string]bool{})
		} else {
			// Anonymous handler: node only, no body to scan.
			g.addNode(hid, "service", r.qual, r.rel, &[2]int{r.line, r.end})
			g.edges[edge{rid, hid, "calls", "EXTRACTED"}] = true
		}
	}
	nodes := make([]node, 0, len(g.nodes))
	for _, n := range g.nodes {
		nodes = append(nodes, n)
	}
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].ID < nodes[j].ID })
	edges := make([]edge, 0, len(g.edges))
	for e := range g.edges {
		edges = append(edges, e)
	}
	sort.Slice(edges, func(i, j int) bool {
		if edges[i].From != edges[j].From {
			return edges[i].From < edges[j].From
		}
		if edges[i].To != edges[j].To {
			return edges[i].To < edges[j].To
		}
		return edges[i].Type < edges[j].Type
	})
	return map[string]any{"nodes": nodes, "edges": edges}, nil
}
