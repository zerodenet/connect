# Marketplace templates

These files match the current unified marketplace product registration (schema 3) and publisher
release-build input that generates `marketplace-entry.json` (schema 1). One product maps to two
host package IDs, and each target keeps independent artifacts and compatibility metadata.

They are deliberately non-releasable: the public key is the marketplace example key, the source
commit is all zeroes, host versions are provisional, and package files do not exist. The release
process must replace those values, build and sign both host packages with the hosts' real tools,
run the marketplace generator against the exact package bytes, then upload the two packages and
generated `marketplace-entry.json` to one immutable GitHub Release.
