# Design

D2 squared combines D2, the diagram language, with Declarative Dragging, a way to build drag and drop from a UIST 2026 paper. The result is D2 diagrams that you can drag. Each drag is saved as a small edit to the `.d2` file.

## Rules

1. The file is the source of truth. Every drag writes plain D2. People, agents and editors all change the same file, and the view follows the file.
2. Meaning comes first. Drop a box on a group and it moves into the group. Drop the end of an arrow on a box and the arrow reconnects. Drop a box on empty space and it is placed there. Hold Alt to always place.
3. Only what you touch changes. The dragged box, its arrows and any group that has to grow change. Everything else stays still, even after an agent adds new boxes.
4. The frame never waits. The dragged box follows the pointer on every frame. Layout work runs next to the drag, never in front of it.
5. What you see is what you save. A drop saves exactly the layout you previewed.
6. Show the edit before it happens. While you hover a drop zone, the panel shows the lines that will change.
7. Undo is file history. Cmd/Ctrl-Z restores the previous file. Esc cancels a drag.

## The model

Declarative Dragging (Horowitz, Blinn, Heer, UIST 2026) says you should not code drag behavior. You list the states a drag can lead to, draw each one, and build the drop zones from where the dragged item lands. For D2 the parts map like this.

| Declarative Dragging | D2 squared |
|---|---|
| State | D2 source |
| Transition | An edit, such as move, reconnect or place |
| Render | Layout plus SVG |
| Behavior | A function from the diagram, the dragged item and the pointer to a list of edits |
| Drop zone | Where the dragged item lands in the layout of an edit |

Almost everything except the behaviors and the drag loop already exists in D2: the compiler, TALA with `top` and `left` positions, `d2oracle` for editing source, and `RouteEdges` for routing arrows around fixed boxes.

## Engine

The engine is a Go package with no network code. It has three parts.

- `Edit` is one change: `move`, `reconnect`, `pin`, `unpin` or `direction`.
- A behavior lists the edits a drag can lead to and builds the result of one edit. The built-in behaviors are `reparent`, `reconnect`, `pin` and `direction`. Others can be added with `Register`.
- `Session` holds the current file, its layout and its history. It has `Open`, `Plan`, `Preview`, `Candidate`, `Route`, `Commit`, `Reload`, `Undo` and `Redo`.

Two programs use it.

- `d2squared serve FILE.d2` runs a local HTTP server, watches the file and serves the web UI.
- The WebAssembly build exposes the same session to JavaScript, so the page can run with no server.

The browser has one `Engine` interface with two implementations. `HttpEngine` talks to `d2squared serve`. `WasmEngine` runs the WebAssembly build in a pool of Web Workers. The page uses `HttpEngine` when it is served by `d2squared serve` and `WasmEngine` otherwise.

## Speed

Each step is more exact and slower than the one before. A slow step never blocks a faster one.

| Step | What it does | Cost, native | When |
|---|---|---|---|
| 0. Move | Move the dragged SVG group | under 1 ms | Every frame |
| 1. Route | Route the arrows that touch the dragged box | 5 to 100 ms | While dragging, throttled |
| 2. Candidates | Lay out each possible result with the other boxes held in place | 35 to 290 ms each | Pointer down, nearest first |
| 3. Full layout | Lay out everything from scratch | 0.1 to 3 s | First open, reset, edits from outside |

Rules that keep it fast:

- Every async result carries a version number. Results for an old version are dropped.
- Releasing the pointer stops work that has not started.
- Candidates are cached by file and edit.
- Candidate work starts on pointer down, not on the first move.
- The page patches the SVG instead of replacing it, and animates boxes between layouts.

In the browser, the primary worker handles the view, arrow routing and commits. The other workers each hold a copy of the current file and build candidates in parallel. A drop is never slower than one candidate build, because the primary worker builds the active zone while you drag.

## Where positions live

Positions are written inline as `top` and `left` inside each box. Every box gets a position on the first edit, because that is the only way a fresh layout of the saved file matches what you saw. Positions of boxes inside a group are relative to the group, plus 60 px of padding. Reset positions gives layout back to TALA.

When an agent adds boxes, the saved positions keep your arrangement and TALA places only the new boxes.

## What the prototypes showed

| Prototype | Result |
|---|---|
| ELK previews, TALA on drop | Previews were fast but landed 250 to 550 px from the saved result. Rejected. |
| Exact TALA previews with other boxes held in place | Zones in 130 to 280 ms. What you see is what you save. Chosen. |
| WebAssembly build of D2 and TALA | Works, about 4 times slower than native. Used for the hosted site. |

Two D2 bugs came up. `d2oracle.MoveIDDeltas` overflows the stack when a box moves into its own descendant. `ReconnectEdge` on `a.col -> b.col` drops the column and leaves the old one behind. The engine avoids both.

## Ideas for D2

These would make the feature a first-class part of D2:

- A helper that lays out a graph with some boxes held in place.
- `d2oracle` edits and `RouteEdges` in `d2.js`.
- Incremental TALA layout.
