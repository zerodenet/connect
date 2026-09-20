.PHONY: check test acceptance-zboard acceptance-znet acceptance-management acceptance-cross-host probe-clean-zboard probe-clean-znet keygen dev release

test:
	go test ./...
	cargo test --manifest-path protocol/v1/reference/rust/Cargo.toml --locked
	node --test znet-sink/test/*.test.mjs tests/interop/*.test.mjs
	python3 scripts/check_repo.py
	python3 -m py_compile scripts/check_release_readiness.py scripts/prepare_dev.py scripts/generate_marketplace_entry.py

check: test
	git diff --check

acceptance-zboard:
	./scripts/test_installed_zboard.sh

acceptance-znet:
	./scripts/test_installed_znet.sh

acceptance-management:
	./scripts/test_management_flow.sh

acceptance-cross-host:
	./scripts/test_cross_host.sh

probe-clean-zboard:
	./scripts/probe_clean_zboard.sh

probe-clean-znet:
	./scripts/probe_clean_znet.sh

keygen:
	go run ./tools/keygen .local

dev:
	./scripts/build_dev.sh "$(VERSION)"

release:
	./scripts/build_dev.sh "$(VERSION)"
