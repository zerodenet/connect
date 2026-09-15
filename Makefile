.PHONY: check test keygen dev

test:
	go test ./...
	node --test znet-sink/test/*.test.mjs tests/interop/*.test.mjs
	python3 scripts/check_repo.py
	python3 -m py_compile scripts/prepare_dev.py scripts/generate_marketplace_entry.py

check: test
	git diff --check

keygen:
	go run ./tools/keygen .local

dev:
	./scripts/build_dev.sh "$(VERSION)"
