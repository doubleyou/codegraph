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
// target-call branch. `srcs`/`hdrs`/`deps`/`data` string lists (incl. simple
// `glob([...])`) become `references` refs carrying the raw label text; the
// starlarkResolver framework (src/resolution/frameworks/starlark.ts) resolves
// file-shaped labels to real `file` nodes (Tier 1 cross-language bridge) and
// `:x` / `//pkg:x` labels to other target nodes (Tier 2 build-dep graph).

/** Keyword-argument names whose string-list value we walk into references. */
const LABEL_LIST_ARGS = new Set(['srcs', 'hdrs', 'deps', 'data', 'exports', 'visibility']);
// `visibility` values (`//visibility:public`) are package-spec labels, not
// deps — walked so a `//pkg:__subpackages__` style value doesn't silently
// vanish, but the resolver treats visibility specs as inert (see below).

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

    const callee = calleeName(node, ctx.source);
    if (!callee) return false;

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
            if (!argName || !LABEL_LIST_ARGS.has(argName) || argName === 'name') continue;
            const value = kwarg.childForFieldName('value');
            if (!value) continue;
            const isGlob = isGlobCall(value, ctx.source);
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
