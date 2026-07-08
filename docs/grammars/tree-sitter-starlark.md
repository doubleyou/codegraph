# tree-sitter-starlark.wasm — provenance

`src/extraction/wasm/tree-sitter-starlark.wasm` is the unmodified prebuilt
artifact shipped in the
[tree-sitter-starlark](https://www.npmjs.com/package/tree-sitter-starlark)
npm package, version `1.3.0`
([tree-sitter-grammars/tree-sitter-starlark](https://github.com/tree-sitter-grammars/tree-sitter-starlark),
MIT). No patch is applied — the file is byte-identical to the npm tarball's
`tree-sitter-starlark.wasm`.

Starlark is a Python dialect used by Bazel (`BUILD`/`BUILD.bazel`,
`WORKSPACE`/`WORKSPACE.bazel`, `MODULE.bazel`, `.bzl`), and also by Buck2,
Please, and Tilt (`.star`). The grammar reuses Python-shaped node types
(`call`, `function_definition`, `string`, `list`) with Starlark's own
`load_statement`-free `load(...)` call convention (`load` is just a regular
call in this grammar, not a distinct node type).

## Why vendored instead of `tree-sitter-wasms`

The `tree-sitter-wasms` npm bundle (CodeGraph's default grammar source) does
not ship a Starlark grammar at all, so it is vendored the same way
Terraform/Nix/ArkTS are (see `src/extraction/grammars.ts`'s vendored-path
branch).

## Health check

```
node scripts/add-lang/check-grammar.mjs src/extraction/wasm/tree-sitter-starlark.wasm sample.bzl
```

ABI version 14. Parses cleanly (20/20 clean parses on a representative
`BUILD`/`.bzl` sample covering `load()`, rule calls, macro `def`s, `glob()`,
and label lists) — no heap-corruption or ERROR-tree symptoms under
web-tree-sitter 0.25's multi-grammar runtime.

## Rebuild / re-vendor

```bash
npm pack tree-sitter-starlark
tar xzf tree-sitter-starlark-*.tgz
cp package/tree-sitter-starlark.wasm src/extraction/wasm/tree-sitter-starlark.wasm
```

Re-run the health check above after any version bump before committing the
new wasm.
