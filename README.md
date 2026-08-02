# lunascripts

Lunascripts (LS) interpreter for MobAI interactive visual novels.

Parses `.md` script files into structured JSON for the frontend player, resolving asset semantic names to OSS URLs.

## Install

```bash
go build -o bin/lsc ./cmd/lsc
```

## Usage

```bash
# Compile a single episode
lsc compile episode.ls.md --assets mapping.json -o output.json

# Compile an entire novel directory
lsc compile novel_001/main/ --assets mapping.json -o novel.json

# Decompile compiled JSON back to LS + recovered asset mapping
lsc decompile output.json
# writes output_decompiled/episode.ls.md and output_decompiled/assets_mapping.json

# Validate syntax only
lsc validate episode.ls.md
```

## Script Format

See [LS-SPEC.md](LS-SPEC.md) for the complete specification.

## Consumer contract

`contract/contract.json` identifies the current LS/Episode JSON contract.
`contract/episode.schema.json` and `contract/fixtures/` are the machine-readable
artifacts consumed by IDE and Backend. Consumers pin an exact repository commit;
language rules must be changed here first rather than patched downstream.

Contract automation is preparation-only:

```bash
node scripts/contractctl.mjs rollout consumers prepare https://github.com/cdotlock/lunascripts/pull/<number>
node scripts/contractctl.mjs rollout consumers sync https://github.com/cdotlock/lunascripts/pull/<number>
node scripts/contractctl.mjs rollout status https://github.com/cdotlock/lunascripts/pull/<number> --json
```

The first command pins the exact candidate SHA in open Backend and IDE PRs. The
second is valid only after that upstream PR is merged into `main` and repins the
same consumer PRs to its reachable canonical merge SHA. Neither command can
merge or release anything. See [the preparation runbook](docs/contract-consumer-preparation.md).

## Development

```bash
make test    # Run all tests
make build   # Build binary
make package # Build dist/ls-dev-<goos>-<goarch>.tar.gz
```
