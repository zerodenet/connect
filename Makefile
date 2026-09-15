.PHONY: check test

test:
	go test ./...
	node --test znet-sink/test/*.test.mjs tests/interop/*.test.mjs
	python3 scripts/check_repo.py

check: test
	git diff --check
