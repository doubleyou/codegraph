import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

// Grammar: tree-sitter-starlark (vendored at src/extraction/wasm/tree-sitter-starlark.wasm,
// tree-sitter-grammars/tree-sitter-starlark 1.3.0, MIT). Starlark is a Python
// dialect, so the grammar reuses Python-shaped nodes (`call`, `function_definition`,
// `string`, `list`) — but BUILD/.bzl semantics are declarative build config, not
// general code, so this extractor is visitNode-driven like terraform.ts rather
// than mapping onto the generic function/class/import dispatch.
//
//   cc_library(name = "foo", srcs = ["foo.cc"], deps = [":bar"])
//   └─ call
//        ├─ function: identifier        ("cc_library")
//        └─ arguments: argument_list
//             ├─ keyword_argument (name: identifier "name", value: string "foo")
//             ├─ keyword_argument (name: identifier "srcs", value: list [string "foo.cc"])
//             └─ keyword_argument (name: identifier "deps", value: list [string ":bar"])
//
// Build targets are any top-level call with a `name=` keyword argument — Bazel
// has hundreds of built-in + custom rule names, so we don't allowlist them.
// `def` in a .bzl file is a macro/rule definition (kind `function`); calls to
// user-defined macros/rules surface as `calls` refs the same way any call does.
// `load(...)` is itself just a call — handled specially before the generic
// target-call branch. Label/file-list attrs (`srcs`, `deps`, `hdrs`, `data`,
// but also any custom rule's own attributes — `proto_deps`, `additional_srcs`,
// etc.) become `references` refs carrying the raw label text; the
// starlarkResolver framework (src/resolution/frameworks/starlark.ts) resolves
// file-shaped labels to real `file` nodes (Tier 1 cross-language bridge) and
// `:x` / `//pkg:x` labels to other target nodes (Tier 2 build-dep graph).
//
// Which kwargs to walk is decided by the VALUE'S SHAPE, not a fixed attribute
// allowlist: Bazel's universal convention for label/file attributes is a
// plain list of string literals (or a `glob([...])` call) — this holds for
// built-in rules and custom ones alike, so a custom rule's own label-list
// attributes are picked up with no per-rule configuration. A small denylist
// suppresses the well-known non-label string lists (compiler flags, tags,
// …) so they don't become junk unresolved refs; everything else — scalars,
// `select(...)`, variables, mixed-type lists — is skipped because it isn't a
// plain label list (silent-beats-wrong: the resolver would never match it
// anyway). One shape besides a list also counts: a single label-shaped
// string (`alias(actual = "//pkg:x")`) — gated on the label prefix itself
// (`:`, `//`, `@`), so a non-label scalar attr is still correctly skipped.

/** Well-known string-list attrs that are never labels/files — kept out of references. */
const NON_LABEL_LIST_ARGS = new Set([
  'copts', 'linkopts', 'defines', 'local_defines', 'includes',
  'tags', 'features', 'args', 'toolchains', 'restricted_to', 'target_compatible_with',
]);

// --- Bzlmod / repository-rule extraction (see plan doc for rationale) ------
//
// MODULE.bazel is the modern Bazel dependency mechanism (replacing WORKSPACE),
// so its two gaps matter most on exactly the repos users index today:
//
//  1. `module(name=X)` / `bazel_dep(name=X)` carry a `name=` kwarg like any
//     build-target call, so without special-casing they'd mint fake `class`
//     (build-target) nodes for every external dependency ("protobuf",
//     "rules_go", ...) — polluting search/impact results with targets that
//     don't exist in this repo. They become `module` nodes instead, gated on
//     the MODULE.bazel filename so a same-named user macro in a .bzl file is
//     unaffected. Standalone nodes, no edges: external modules aren't
//     indexed, so an edge would just point at nothing.
//
//  2. `x = repository_rule(...)` / `rule(...)` / `provider(...)` / `aspect(...)`
//     / `module_extension(...)` / `tag_class(...)` / `macro(...)` are
//     assignment-wrapped definitions — the call itself has no `name=`, so
//     without special-casing the LHS name is discarded and only a stray
//     `calls` ref to e.g. "repository_rule" survives. These become `function`
//     nodes named by the LHS identifier, so `load("//:defs.bzl", "x")` can
//     resolve to them via the generic name matcher.
//
// Two deliberate frontiers, left silent (no false positives):
//  3. Positional-name calls (`external_http_archive("grpc", ...)`) can't be
//     distinguished from any other helper call taking a string first arg
//     without risking false targets.
//  4. Non-`native` dotted-method calls (`go_deps.from_file(...)`) are dropped
//     silently; only `native.<rule>(name=...)` is recovered below, since that
//     is a real, unambiguous build target (`native.cc_library` etc).

const BZLMOD_MODULE_CALLS = new Set(['module', 'bazel_dep']);

function isModuleBazelFile(filePath: string): boolean {
  return filePath.slice(filePath.lastIndexOf('/') + 1) === 'MODULE.bazel';
}

/** Definition-constructor builtins whose assignment target is the real definition name. */
const DEFINITION_BUILTINS = new Set([
  'rule', 'repository_rule', 'provider', 'aspect', 'module_extension', 'tag_class', 'macro',
]);

/** If `call` is the RHS of `name = call(...)`, return `name`; else null. */
function assignmentTargetName(call: SyntaxNode, source: string): string | null {
  const parent = call.parent;
  if (!parent || parent.type !== 'assignment') return null;
  // web-tree-sitter node wrappers aren't reference-stable across accessors
  // (a node reached via .parent vs. via the original walk are `!==` even for
  // the same underlying node) — compare by position instead of `===`.
  const right = parent.childForFieldName('right');
  if (!right || right.startIndex !== call.startIndex || right.endIndex !== call.endIndex) return null;
  const left = parent.childForFieldName('left');
  if (!left || left.type !== 'identifier') return null;
  return getNodeText(left, source);
}

/** `native.cc_library(...)` -> {name: 'cc_library', isNative: true}; `go_deps.from_file(...)` -> {name: 'go_deps.from_file', isNative: false}. */
function attributeCallee(call: SyntaxNode, source: string): { name: string; isNative: boolean } | null {
  const fn = call.childForFieldName('function');
  if (!fn || fn.type !== 'attribute') return null;
  const objNode = fn.childForFieldName('object');
  const attrNode = fn.childForFieldName('attribute');
  if (!objNode || !attrNode) return null;
  const obj = getNodeText(objNode, source);
  const attr = getNodeText(attrNode, source);
  return { name: obj === 'native' ? attr : `${obj}.${attr}`, isNative: obj === 'native' };
}

/** Read a `string` node's literal text (its `string_content` child), or null for empty/unsupported. */
function stringValue(node: SyntaxNode, source: string): string | null {
  const content = node.namedChildren.find((c) => c?.type === 'string_content');
  return content ? getNodeText(content, source) : (node.type === 'string' ? '' : null);
}

/** The `name` field of a `call` node's `function`. */
function calleeName(call: SyntaxNode, source: string): string | null {
  const fn = call.childForFieldName('function');
  if (!fn || fn.type !== 'identifier') return null;
  return getNodeText(fn, source);
}

/** All `keyword_argument` children of a call's `argument_list`. */
function keywordArgs(call: SyntaxNode): SyntaxNode[] {
  const args = call.childForFieldName('arguments');
  if (!args) return [];
  return args.namedChildren.filter((c): c is SyntaxNode => c?.type === 'keyword_argument');
}

function kwargName(kwarg: SyntaxNode, source: string): string | null {
  const name = kwarg.childForFieldName('name');
  return name ? getNodeText(name, source) : null;
}

/** Read a `keyword_argument`'s `name = "literal"` value, or null if not a plain string. */
function kwargStringValue(kwarg: SyntaxNode, source: string): string | null {
  const value = kwarg.childForFieldName('value');
  if (!value || value.type !== 'string') return null;
  return stringValue(value, source);
}

/**
 * Every string literal inside a keyword arg's value — handles a bare `list`
 * of strings AND `glob([...])` (a `call` whose own arguments are a string
 * list; the pattern strings, not the expansion, are what we collect — the
 * resolver expands glob patterns against the indexed file set).
 */
function collectLabelStrings(value: SyntaxNode, source: string): { pattern: string; node: SyntaxNode }[] {
  const out: { pattern: string; node: SyntaxNode }[] = [];
  const queue: SyntaxNode[] = [value];
  while (queue.length) {
    const n = queue.shift()!;
    if (n.type === 'string') {
      const v = stringValue(n, source);
      if (v) out.push({ pattern: v, node: n });
      continue;
    }
    for (const c of n.namedChildren) {
      if (c) queue.push(c);
    }
  }
  return out;
}

/** Is this call's value a `glob([...])` invocation (vs. a plain list / variable)? */
function isGlobCall(value: SyntaxNode, source: string): boolean {
  return value.type === 'call' && calleeName(value, source) === 'glob';
}

/** A `list` node whose every named child is a `string` literal (a label/file list, not a variable/select/mixed list). */
function isStringList(value: SyntaxNode): boolean {
  return (
    value.type === 'list' &&
    value.namedChildren.length > 0 &&
    value.namedChildren.every((c) => c?.type === 'string')
  );
}

/**
 * A single label-shaped string, e.g. `actual = "//source/exe:envoy"` on
 * `alias()`. Unlike `srcs`/`deps`/etc. (always lists), a handful of built-in
 * attrs — `actual` chief among them — take exactly one label as a bare
 * string. Gated on the label shape itself (`:x`, `//pkg:x`, `@repo//...`),
 * the same shapes the resolver already claims, so a scalar that ISN'T a label
 * (a rule's plain string attr, e.g. `cmd = "echo hi"`) is correctly skipped —
 * no attribute-name allowlist needed, consistent with the value-shape-driven
 * design above.
 */
function isSingleLabelString(value: SyntaxNode, source: string): boolean {
  if (value.type !== 'string') return false;
  const v = stringValue(value, source);
  return !!v && (v.startsWith(':') || v.startsWith('//') || v.startsWith('@'));
}

export const starlarkExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: [],
  variableTypes: [],
  nameField: '',
  bodyField: '',
  paramsField: '',

  visitNode: (node, ctx) => {
    // Macro/rule definitions in .bzl files: `def my_macro(...): ...`
    if (node.type === 'function_definition') {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) return false;
      const name = getNodeText(nameNode, ctx.source);
      const created = ctx.createNode('function', name, node, {
        signature: `def ${name}(...)`,
      });
      if (!created) return true;
      const body = node.childForFieldName('body');
      if (body) {
        ctx.pushScope(created.id);
        try {
          // Not ctx.visitFunctionBody: that generic walker dispatches on
          // extractor.callTypes, which this extractor deliberately leaves
          // empty (everything is visitNode-driven). Recursing through
          // ctx.visitNode instead lets our own call-handling branch below
          // fire for calls nested in a macro/rule-definition body (both
          // target calls like `native.cc_library(...)` and bare helper
          // calls), the same way the top-level module walk does.
          for (const child of body.namedChildren) {
            if (child) ctx.visitNode(child);
          }
        } finally {
          ctx.popScope();
        }
      }
      return true;
    }

    if (node.type !== 'call') return false;

    let callee = calleeName(node, ctx.source);
    if (!callee) {
      // Not a bare identifier callee — try native.<rule>(...) recovery
      // (item 4). Any other dotted callee (go_deps.from_file, ctx.actions.run,
      // ...) is a deliberate silent frontier: dropped, no calls ref.
      const attrCallee = attributeCallee(node, ctx.source);
      if (!attrCallee || !attrCallee.isNative) return false;
      callee = attrCallee.name;
    }

    // x = rule(...) / repository_rule(...) / provider(...) / aspect(...) /
    // module_extension(...) / tag_class(...) — the assignment LHS is the real
    // definition name; recover it as a `function` node instead of losing it
    // to a stray `calls` ref. Bare (non-assigned) calls to these builtins fall
    // through to the generic calls-ref branch below, unchanged.
    if (DEFINITION_BUILTINS.has(callee)) {
      const defName = assignmentTargetName(node, ctx.source);
      if (defName) {
        ctx.createNode('function', defName, node, {
          signature: `${defName} = ${callee}(...)`,
        });
        return true;
      }
    }

    // load("//pkg:defs.bzl", "sym1", "sym2", ...) — an import of the .bzl file.
    if (callee === 'load') {
      const args = node.childForFieldName('arguments');
      const positional = args?.namedChildren.filter((c): c is SyntaxNode => c?.type === 'string') ?? [];
      const bzlLabel = positional[0] ? stringValue(positional[0], ctx.source) : null;
      if (!bzlLabel) return true; // malformed load(); nothing to do
      const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1] ?? ctx.nodeStack[0];
      if (fromNodeId) {
        ctx.addUnresolvedReference({
          fromNodeId,
          referenceName: bzlLabel,
          referenceKind: 'imports',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
      return true; // don't also treat load() as a build-target call
    }

    // MODULE.bazel: module(name=X) / bazel_dep(name=X) declare a Bzlmod
    // dependency, not a build target — become `module` nodes (item 1),
    // never the `class` target nodes below (that would mint a fake build
    // target for every external dependency, e.g. "protobuf", "rules_go").
    // Filename-gated so a same-named macro in an ordinary .bzl file is
    // unaffected. Always consumed (`return true`), even if `name=` is
    // missing/non-literal, so it never falls through to the target branch.
    if (isModuleBazelFile(ctx.filePath) && BZLMOD_MODULE_CALLS.has(callee)) {
      const kwargs = keywordArgs(node);
      const nameKwarg = kwargs.find((k) => kwargName(k, ctx.source) === 'name');
      const modName = nameKwarg ? kwargStringValue(nameKwarg, ctx.source) : null;
      if (modName) {
        ctx.createNode('module', modName, node, {
          signature: `${callee}(name = "${modName}")`,
        });
      }
      return true;
    }

    // A build-target call: any call with a `name=` kwarg (cc_library, py_binary,
    // a user-defined macro invocation, etc.). Bazel has hundreds of built-in and
    // custom rule names, so we key off the `name=` convention rather than an
    // allowlist — any call missing it (glob(), select(), a plain macro helper
    // with no name=) falls through to the generic calls-ref handling below.
    const kwargs = keywordArgs(node);
    const nameKwarg = kwargs.find((k) => kwargName(k, ctx.source) === 'name');
    const targetName = nameKwarg ? kwargStringValue(nameKwarg, ctx.source) : null;

    if (targetName) {
      const created = ctx.createNode('class', targetName, node, {
        signature: `${callee}(name = "${targetName}")`,
      });
      if (created) {
        ctx.pushScope(created.id);
        try {
          for (const kwarg of kwargs) {
            const argName = kwargName(kwarg, ctx.source);
            if (!argName || argName === 'name' || NON_LABEL_LIST_ARGS.has(argName)) continue;
            const value = kwarg.childForFieldName('value');
            if (!value) continue;
            if (isSingleLabelString(value, ctx.source)) {
              const pattern = stringValue(value, ctx.source)!;
              ctx.addUnresolvedReference({
                fromNodeId: created.id,
                referenceName: pattern,
                referenceKind: 'references',
                line: value.startPosition.row + 1,
                column: value.startPosition.column,
              });
              continue;
            }
            const isGlob = isGlobCall(value, ctx.source);
            if (!isGlob && !isStringList(value)) continue;
            for (const { pattern, node: strNode } of collectLabelStrings(value, ctx.source)) {
              ctx.addUnresolvedReference({
                fromNodeId: created.id,
                referenceName: pattern,
                referenceKind: 'references',
                line: strNode.startPosition.row + 1,
                column: strNode.startPosition.column,
                candidates: isGlob ? [`glob:${pattern}`] : undefined,
              });
            }
          }
        } finally {
          ctx.popScope();
        }
      }
      return true;
    }

    // Not a target call (e.g. a helper call, `select(...)`, a macro with no
    // name=) — let it fall through to a generic calls ref so "what calls X"
    // still surfaces macro invocations without a name= convention.
    const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1] ?? ctx.nodeStack[0];
    if (fromNodeId) {
      ctx.addUnresolvedReference({
        fromNodeId,
        referenceName: callee,
        referenceKind: 'calls',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
    return false; // let the default walker still descend into arguments
  },
};
