/**
 * Starlark (Bazel) Framework Resolver
 *
 * Bazel labels have their own scoping/addressing rules the generic name
 * matcher doesn't know: `:name` is a same-package target, `//pkg/path:name`
 * is a workspace-absolute target, and `@repo//pkg:name` crosses into an
 * external repository this index doesn't contain. Bare strings in `srcs`/
 * `hdrs`/`data` are plain source-file paths, not labels at all. This
 * resolver implements exactly two things (by design — see the project's
 * add-lang plan for Starlark):
 *
 *   Tier 1 — `srcs`/`hdrs`/`data` refs (incl. simple `glob([...])`, marked by
 *   the extractor with a `glob:<pattern>` candidate) resolve to the real
 *   `file` node they name, in the same package directory as the target. This
 *   is the cross-language bridge: an agent reaches a target's C++/Python/etc.
 *   symbols via `target -> file -> contains -> symbol`, one hop past this
 *   edge, without CodeGraph ever materializing target->symbol edges directly
 *   (that would fan out badly on a god-target and is redundant with this).
 *
 *   Tier 2 — `deps`/`data`/`exports` label refs resolve to the other BUILD
 *   target they name: `:x` and bare `x` in the same package, `//pkg:x`
 *   workspace-absolute. `@repo//...` (external repository) is left
 *   unresolved — this index has no visibility into another repo's targets,
 *   and a wrong guess is worse than a visible boundary.
 *
 * `load("//pkg:defs.bzl", ...)` is extracted as an `imports` ref carrying the
 * raw label; resolved here to the `.bzl` file node the same way.
 *
 * No target->target confidence tie-breaking beyond "exactly one candidate
 * matches" is attempted: Bazel labels are unambiguous by construction (one
 * target of a given name per package), so multiple candidates means the ref
 * is malformed or points at a package this index doesn't have — stay
 * unresolved rather than guess.
 */

import * as path from 'path';
import type { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

const GLOB_PREFIX = 'glob:';

export const starlarkResolver: FrameworkResolver = {
  name: 'starlark',
  languages: ['starlark'],

  detect(context: ResolutionContext): boolean {
    return context.getAllFiles().some((f) => isBuildFile(f) || f.endsWith('.bzl') || f.endsWith('.star'));
  },

  // Target labels (`:x`, `//pkg:x`) and glob patterns (`*.cc`) name no
  // declared symbol and no file by their literal text, so the resolver's
  // name-exists pre-filter would otherwise drop them before resolve() runs.
  // Only claim the shapes this resolver actually understands — a plain
  // relative file path (`bar.cc`) still needs to match a real `file` node
  // name, so it's deliberately NOT claimed here.
  claimsReference(name: string): boolean {
    return name.startsWith(':') || name.startsWith('//') || /^\*\.[A-Za-z0-9_]+$/.test(name) || name.startsWith('**/');
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.language !== 'starlark') return null;

    const label = ref.referenceName;
    const pkgDir = dirOf(ref.filePath);

    if (ref.referenceKind === 'imports') {
      return resolveBzlLoad(ref, label, pkgDir, context);
    }

    if (ref.referenceKind !== 'references') return null;

    // External repository label (`@repo//pkg:target`) — out of this index's
    // reach. A visible boundary beats a wrong guess.
    if (label.startsWith('@')) return null;

    const glob = ref.candidates?.find((c) => c.startsWith(GLOB_PREFIX));
    if (glob) {
      return resolveGlobPattern(ref, glob.slice(GLOB_PREFIX.length), pkgDir, context);
    }

    // A Bazel label (`:x`, `//pkg:x`, or bare `x` used as a same-package dep)
    // vs. a plain source-file path (`foo.cc`, `sub/dir/bar.h`). Labels never
    // contain a `.` before the final path segment's extension the way a
    // multi-segment file path can, but the reliable signal is simpler: a
    // `:`-scoped or `//`-rooted string is unambiguously a label; anything
    // else is tried as a target name first (deps convention), then as a file
    // path (srcs/hdrs/data convention).
    const targetResolved = resolveTargetLabel(ref, label, pkgDir, context);
    if (targetResolved) return targetResolved;

    return resolveSourceFile(ref, label, pkgDir, context);
  },
};

function isBuildFile(filePath: string): boolean {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  return base === 'BUILD' || base === 'BUILD.bazel';
}

/** Directory of a stored (forward-slash, project-relative) path. */
function dirOf(p: string): string {
  const d = path.dirname(p);
  return d === '' ? '.' : d;
}

function joinDir(base: string, rel: string): string {
  return path.normalize(base === '.' ? rel : `${base}/${rel}`).replace(/\\/g, '/');
}

/** Parse `:name`, `//pkg/path:name`, or bare `name` into { pkgDir, name }. Returns null for `@repo//...` (caller filters that earlier) or malformed labels. */
function parseLabel(label: string, refPkgDir: string): { pkgDir: string; name: string } | null {
  if (label.startsWith('//')) {
    const colon = label.indexOf(':');
    const pkgPath = colon === -1 ? label.slice(2) : label.slice(2, colon);
    const name = colon === -1 ? pkgPath.split('/').pop() ?? '' : label.slice(colon + 1);
    if (!name) return null;
    return { pkgDir: pkgPath === '' ? '.' : pkgPath, name };
  }
  if (label.startsWith(':')) {
    const name = label.slice(1);
    if (!name) return null;
    return { pkgDir: refPkgDir, name };
  }
  // Bare name with no `/` — usable as an implicit same-package target ref
  // (the common `deps = ["foo"]` shorthand some BUILD files use). A bare
  // string containing `/` is virtually always a source-file path instead.
  if (!label.includes('/') && label.length > 0) {
    return { pkgDir: refPkgDir, name: label };
  }
  return null;
}

function resolveTargetLabel(
  ref: UnresolvedRef,
  label: string,
  refPkgDir: string,
  context: ResolutionContext
): ResolvedRef | null {
  const parsed = parseLabel(label, refPkgDir);
  if (!parsed) return null;
  const candidates = context
    .getNodesByName(parsed.name)
    .filter((n) => n.kind === 'class' && dirOf(n.filePath) === parsed.pkgDir);
  if (candidates.length !== 1) return null;
  return { original: ref, targetNodeId: candidates[0]!.id, confidence: 0.9, resolvedBy: 'framework' };
}

function resolveSourceFile(
  ref: UnresolvedRef,
  relPath: string,
  pkgDir: string,
  context: ResolutionContext
): ResolvedRef | null {
  if (relPath.startsWith(':') || relPath.startsWith('//') || relPath.startsWith('@')) return null;
  const target = joinDir(pkgDir, relPath);
  const fileNode = context.getNodesInFile(target).find((n) => n.kind === 'file');
  if (!fileNode) return null;
  return { original: ref, targetNodeId: fileNode.id, confidence: 0.95, resolvedBy: 'framework' };
}

/**
 * Expand a simple glob (`*.cc`, a recursive `*.h` pattern, no double-star
 * mid-pattern, no exclude) against files in pkgDir. Resolves only when
 * exactly one file matches — a glob fanning out to many files is real, but
 * this resolver emits one edge per literal ref, so an ambiguous multi-file
 * glob stays a visible target-to-package boundary rather than picking
 * arbitrarily.
 */
function resolveGlobPattern(
  ref: UnresolvedRef,
  pattern: string,
  pkgDir: string,
  context: ResolutionContext
): ResolvedRef | null {
  const recursive = pattern.startsWith('**/');
  const suffix = recursive ? pattern.slice(3) : pattern;
  if (!suffix.startsWith('*.')) return null; // only the common "*.ext" shape
  const ext = suffix.slice(1); // ".ext"

  const matches = context.getAllFiles().filter((f) => {
    if (!f.endsWith(ext)) return false;
    const d = dirOf(f);
    return recursive ? d === pkgDir || d.startsWith(`${pkgDir}/`) : d === pkgDir;
  });
  if (matches.length !== 1) return null;
  const fileNode = context.getNodesInFile(matches[0]!).find((n) => n.kind === 'file');
  if (!fileNode) return null;
  return { original: ref, targetNodeId: fileNode.id, confidence: 0.7, resolvedBy: 'framework' };
}

/** `load("//pkg:defs.bzl", ...)` / `load(":defs.bzl", ...)` -> the .bzl file node. */
function resolveBzlLoad(
  ref: UnresolvedRef,
  label: string,
  refPkgDir: string,
  context: ResolutionContext
): ResolvedRef | null {
  if (label.startsWith('@')) return null; // external repo — out of reach
  let pkgDir: string;
  let filename: string;
  if (label.startsWith('//')) {
    const colon = label.indexOf(':');
    if (colon === -1) return null;
    pkgDir = label.slice(2, colon) || '.';
    filename = label.slice(colon + 1);
  } else if (label.startsWith(':')) {
    pkgDir = refPkgDir;
    filename = label.slice(1);
  } else {
    return null;
  }
  if (!filename.endsWith('.bzl')) return null;
  const target = joinDir(pkgDir, filename);
  const fileNode = context.getNodesInFile(target).find((n) => n.kind === 'file');
  if (!fileNode) return null;
  return { original: ref, targetNodeId: fileNode.id, confidence: 0.95, resolvedBy: 'framework' };
}

// Re-exported for tests.
export const _internal = { parseLabel, dirOf, joinDir };
