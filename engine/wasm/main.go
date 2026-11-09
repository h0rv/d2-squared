//go:build js && wasm

package main

import (
	"context"
	"encoding/json"
	"errors"
	"syscall/js"

	"github.com/h0rv/d2-squared/engine"
)

var session = engine.NewSession(nil)

func promise(fn func() (any, error)) any {
	handler := js.FuncOf(func(_ js.Value, args []js.Value) any {
		resolve, reject := args[0], args[1]
		go func() {
			out, err := fn()
			if err != nil {
				reject.Invoke(js.Global().Get("Error").New(err.Error()))
				return
			}
			raw, err := json.Marshal(out)
			if err != nil {
				reject.Invoke(js.Global().Get("Error").New(err.Error()))
				return
			}
			resolve.Invoke(string(raw))
		}()
		return nil
	})
	return js.Global().Get("Promise").New(handler)
}

func decode[T any](raw string) (T, error) {
	var v T
	err := json.Unmarshal([]byte(raw), &v)
	return v, err
}

func stale(err error) error {
	if errors.Is(err, engine.ErrStale) {
		return errors.New("stale version")
	}
	return err
}

func open(_ js.Value, args []js.Value) any {
	source := args[0].String()
	return promise(func() (any, error) { return session.Open(source) })
}

func reload(_ js.Value, args []js.Value) any {
	source := args[0].String()
	return promise(func() (any, error) {
		v, err := session.Reload(source)
		if v.Error != "" {
			return v, nil
		}
		return v, err
	})
}

func plan(_ js.Value, args []js.Value) any {
	target, at, version := args[0].String(), args[1].String(), int64(args[2].Int())
	return promise(func() (any, error) {
		t, err := decode[engine.Target](target)
		if err != nil {
			return nil, err
		}
		p, err := decode[engine.Point](at)
		if err != nil {
			return nil, err
		}
		edits, err := session.Plan(t, p, version)
		return edits, stale(err)
	})
}

func candidate(_ js.Value, args []js.Value) any {
	edit, version := args[0].String(), int64(args[1].Int())
	return promise(func() (any, error) {
		e, err := decode[engine.Edit](edit)
		if err != nil {
			return nil, err
		}
		c, err := session.Candidate(context.Background(), e, version)
		return c, stale(err)
	})
}

func route(_ js.Value, args []js.Value) any {
	target, delta, version := args[0].String(), args[1].String(), int64(args[2].Int())
	return promise(func() (any, error) {
		t, err := decode[engine.Target](target)
		if err != nil {
			return nil, err
		}
		d, err := decode[engine.Point](delta)
		if err != nil {
			return nil, err
		}
		paths, err := session.Route(t, d, version)
		return map[string]any{"paths": paths}, stale(err)
	})
}

func commit(_ js.Value, args []js.Value) any {
	edit, version := args[0].String(), int64(args[1].Int())
	return promise(func() (any, error) {
		e, err := decode[engine.Edit](edit)
		if err != nil {
			return nil, err
		}
		_, v, err := session.Commit(context.Background(), e, version)
		return v, stale(err)
	})
}

func history(step func() (engine.View, error)) js.Func {
	return js.FuncOf(func(js.Value, []js.Value) any {
		return promise(func() (any, error) { return step() })
	})
}

func view(js.Value, []js.Value) any {
	return promise(func() (any, error) { return session.Snapshot(), nil })
}

func verify(js.Value, []js.Value) any {
	return promise(func() (any, error) { return session.Verify(context.Background()) })
}

func main() {
	api := js.Global().Get("Object").New()
	api.Set("open", js.FuncOf(open))
	api.Set("reload", js.FuncOf(reload))
	api.Set("view", js.FuncOf(view))
	api.Set("plan", js.FuncOf(plan))
	api.Set("candidate", js.FuncOf(candidate))
	api.Set("route", js.FuncOf(route))
	api.Set("commit", js.FuncOf(commit))
	api.Set("undo", history(session.Undo))
	api.Set("redo", history(session.Redo))
	api.Set("verify", js.FuncOf(verify))
	js.Global().Set("d2squared", api)
	if ready := js.Global().Get("d2squaredReady"); ready.Type() == js.TypeFunction {
		ready.Invoke()
	}
	select {}
}
