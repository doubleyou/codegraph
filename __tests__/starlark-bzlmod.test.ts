/**
 * Bzlmod (MODULE.bazel) and repository-rule extraction gaps.
 *
 * Two bugs the plain name= convention introduces on real Bzlmod repos:
 *   - `module(name=X)` / `bazel_dep(name=X)` look exactly like a build-target
 *     call, so without special-casing every external dependency mints a fake
 *     `class` (build-target) node.
 *   - `x = repository_rule(...)` / `rule(...)` / `provider(...)` / ... are
 *     assignment-wrapped, so the LHS name is discarded and the definition is
 *     invisible.
 * Plus one recovered target shape (`native.<rule>(name=...)`) and two
 * deliberately-silent frontiers (positional-name targets, non-native dotted
 * calls) pinned as negative tests so a future change doesn't quietly "fix"
 * them into false positives.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('Starlark Bzlmod / repository-rule extraction', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starlark-bzlmod-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('MODULE.bazel: module()/bazel_dep() become module nodes, not fake build targets', async () => {
    fs.writeFileSync(
      path.join(dir, 'MODULE.bazel'),
      `module(name = "envoy")
bazel_dep(name = "rules_cc")
use_repo(rules_cc_ext, "rules_cc_extra")
`
    );
    // Control: an ordinary BUILD target still becomes a class node.
    fs.writeFileSync(
      path.join(dir, 'BUILD'),
      `cc_library(name = "foo", srcs = ["foo.cc"])
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const count = (name: string, kind: string) =>
      db.prepare(`SELECT count(*) c FROM nodes WHERE name = ? AND kind = ?`).get(name, kind).c;

    expect(count('envoy', 'module')).toBe(1);
    expect(count('rules_cc', 'module')).toBe(1);
    // Anti-pollution: neither becomes a fake build-target `class` node.
    expect(count('envoy', 'class')).toBe(0);
    expect(count('rules_cc', 'class')).toBe(0);
    // use_repo isn't in the module/bazel_dep allowlist — no module node minted.
    expect(count('rules_cc_extra', 'module')).toBe(0);
    // Control: a real BUILD target is unaffected.
    expect(count('foo', 'class')).toBe(1);

    cg.close?.();
  });

  it('does not turn a same-named macro call in an ordinary .bzl file into a module node', async () => {
    fs.writeFileSync(
      path.join(dir, 'defs.bzl'),
      `def module(name):
    pass

module(name = "not_a_bzlmod_module")
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    expect(
      db.prepare(`SELECT count(*) c FROM nodes WHERE name = 'not_a_bzlmod_module' AND kind = 'module'`).get().c
    ).toBe(0);

    cg.close?.();
  });

  it('repository_rule/rule/provider/aspect/module_extension/tag_class assignments become function nodes', async () => {
    fs.writeFileSync(
      path.join(dir, 'defs.bzl'),
      `my_repo = repository_rule(implementation = _impl)
my_rule = rule(implementation = _rule_impl)
MyInfo = provider(fields = ["x"])
my_ext = module_extension(implementation = _ext_impl)
my_aspect = aspect(implementation = _aspect_impl)
my_tag = tag_class(attrs = {})

# Bare (non-assigned) call: no LHS to recover, falls through to a calls ref.
repository_rule(implementation = _impl)

# Not a definition builtin — a plain value constructor must not become a node.
x = struct(a = 1)
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const fn = (name: string) =>
      db.prepare(`SELECT count(*) c FROM nodes WHERE name = ? AND kind = 'function'`).get(name).c;

    expect(fn('my_repo')).toBe(1);
    expect(fn('my_rule')).toBe(1);
    expect(fn('MyInfo')).toBe(1);
    expect(fn('my_ext')).toBe(1);
    expect(fn('my_aspect')).toBe(1);
    expect(fn('my_tag')).toBe(1);

    // The old stray "repository_rule"-named node/ref is gone.
    expect(db.prepare(`SELECT count(*) c FROM nodes WHERE name = 'repository_rule'`).get().c).toBe(0);

    // `x = struct(...)` is a value, not a definition builtin — no function node `x`.
    expect(fn('x')).toBe(0);

    cg.close?.();
  });

  it('leaves positional-name target calls silent (deliberate frontier)', async () => {
    fs.writeFileSync(
      path.join(dir, 'repositories.bzl'),
      `external_http_archive("grpc", patches = ["x.patch"])
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    expect(db.prepare(`SELECT count(*) c FROM nodes WHERE name = 'grpc'`).get().c).toBe(0);

    cg.close?.();
  });

  it('recovers native.<rule>(name=...) as a real build target but drops other dotted calls silently', async () => {
    fs.writeFileSync(
      path.join(dir, 'defs.bzl'),
      `def _impl(ctx):
    native.cc_library(name = "foo", srcs = ["a.cc"])
    go_deps.from_file(go_mod = "//:go.mod")
`
    );
    fs.writeFileSync(path.join(dir, 'a.cc'), `// nothing\n`);

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    expect(db.prepare(`SELECT count(*) c FROM nodes WHERE name = 'foo' AND kind = 'class'`).get().c).toBe(1);
    const refs = db
      .prepare(
        `SELECT t.name FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE s.name = 'foo' AND e.kind = 'references'`
      )
      .all()
      .map((r: any) => r.name);
    expect(refs).toContain('a.cc');

    // Non-native dotted call: no node, no calls ref.
    expect(db.prepare(`SELECT count(*) c FROM nodes WHERE name = 'from_file'`).get().c).toBe(0);
    expect(
      db.prepare(`SELECT count(*) c FROM edges WHERE kind = 'calls' AND target IN (SELECT id FROM nodes WHERE name = 'from_file')`).get().c
    ).toBe(0);

    cg.close?.();
  });
});
