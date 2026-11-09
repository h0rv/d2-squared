package main

import (
	"embed"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
)

//go:embed all:ui
var assets embed.FS

const usage = `usage: d2squared serve [-addr host:port] FILE.d2`

func main() {
	if len(os.Args) < 2 || os.Args[1] != "serve" {
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	flags := flag.NewFlagSet("serve", flag.ExitOnError)
	addr := flags.String("addr", "127.0.0.1:8768", "listen address")
	_ = flags.Parse(os.Args[2:])
	if flags.NArg() != 1 {
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}
	path := flags.Arg(0)
	s, v, err := newServer(path)
	if err != nil {
		log.Fatal(err)
	}
	go s.watch()
	ui, err := fs.Sub(assets, "ui")
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("editing %s on http://%s (%d shapes, layout %.0f ms)", path, *addr, len(v.Shapes), v.LayoutMS)
	if err := http.ListenAndServe(*addr, s.routes(ui)); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
