# D2²

![Fixing a diagram by dragging a box into a group and an arrow onto another box in D2 squared](docs/demo.gif)

D2² (D2 squared) is D2 × D2. It combines two projects that are both called D2.

- [D2](https://d2lang.com), short for Declarative Diagramming, is a language for writing diagrams as text.
- [Declarative Dragging](https://declarative-dragging.github.io/), also shortened to D2, is a new way to build drag and drop, from a UIST 2026 paper by Horowitz, Blinn and Heer. You describe the states a drag can lead to, and the drop zones come from those states.

Together they make D2 diagrams draggable. You can move a box into a group, drag the end of an arrow onto another box, or place a box where you want it. Each drag is saved as a small edit to your `.d2` file, so the text stays the source of truth.

You can also:

- Switch the layout engine between TALA, ELK and dagre.
- See the diagram as text, in Unicode or ASCII.
- Turn on sketch mode or pick a D2 theme.
- Export SVG, PNG or text.

## Try it

- Open the site: https://horv.co/d2-squared/. Nothing to install. It runs in your browser. Drop your own .d2 file on the page, or paste D2 text.
- Or edit a file on your machine:

```sh
go install github.com/h0rv/d2-squared/engine/cmd/d2squared@latest
d2squared serve diagram.d2
```

Then open http://127.0.0.1:8768. Drags are written to `diagram.d2`, and changes you make in your editor appear in the page.

## How it works

When you start a drag, D2² works out the edits that drag could make and lays out the result of each one. The group you would drop into lights up. If the code panel is open, it shows the lines that would change. The layout you preview is the layout that is saved.

Work is split into steps so the drag never waits.

| Step | What it does | When |
|---|---|---|
| Move | Moves the dragged shape | Every frame |
| Route | Redraws the arrows that touch it | While dragging |
| Results | Lays out each possible drop | From the start of the drag, nearest first |
| Full layout | Lays out everything again | First open, reset, edits from outside |

Boxes you did not touch keep their place. D2² saves their positions as `top` and `left` in the file, so a fresh layout matches what you saw. See [docs/DESIGN.md](docs/DESIGN.md) for details.

## How it uses Declarative Dragging

In D2², each drag state is a version of the `.d2` file, e.g., the file with a box moved into another group. D2² lays out each version and shows a drop zone where the box lands. The paper's library, dragology, is for React and needs each state to render at once. D2 layouts take longer, so D2² has its own small drag loop that follows the same idea.

## Limits

- The browser engine is about 4 times slower than the native one, and it downloads about 12 MB once.
- Small diagrams feel instant in the browser. A 36 table diagram takes a few seconds to open, so use `d2squared serve` for large ones.
- The first edit saves a position for every box, so the file gets longer. Auto-arrange everything removes them.
- Placing and resizing boxes need TALA. ELK and dagre ignore saved positions.

## Develop

You need Go and Node.js.

```sh
make ui      # build the web UI that d2squared embeds
make test    # Go tests, lint, typecheck and the Playwright tests
```

The Go engine is in `engine/` and the web app is in `web/`. `npm run build` in `web/` builds the WebAssembly engine and the site.

## Credits

- [D2](https://d2lang.com) by Terrastruct and Hack Club, and its TALA layout engine.
- [Declarative Dragging](https://declarative-dragging.github.io/) and dragology, by Horowitz, Blinn and Heer.

## License

[MPL-2.0](LICENSE), the same license as D2.
