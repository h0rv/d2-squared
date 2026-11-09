.PHONY: all wasm ui test lint fmt serve

all: ui wasm

ui:
	cd web && npm ci && npm run build:embed

wasm:
	cd web && npm run wasm

test:
	cd engine && go vet ./... && go test ./...
	cd web && npm run typecheck && npm run lint && npm test

lint:
	cd engine && test -z "$$(gofmt -l .)" && go vet ./...
	cd web && npm run lint && npm run format:check && npm run typecheck

fmt:
	cd engine && gofmt -w .
	cd web && npm run format

serve:
	cd engine && go run ./cmd/d2squared serve ../examples/architecture.d2
