/**
 * Which changed paths no test run can check (docs/AGENT-LOOP-DESIGN.md §3.3), zero-import so the agent driver
 * (`src/agent/driver.ts`, rule 2 of `agent.verify tests`) and the engine (`lastChangeStep`, which decides whether the
 * last test run is current for `complete`) apply one rule: a change to docs alone neither arms a verify nor makes a
 * green run stale.
 */

/** Extensions of files no test run can check: prose, markup and images. */
const DOCS_EXT_RE = /\.(md|mdx|markdown|rst|txt|adoc|asciidoc|org|png|jpe?g|gif|svg|webp|ico)$/i;
/** Base names of the usual project documents with no extension (`LICENSE`, `LICENSE-MIT`, `README`); `NOTICE.md` is DOCS_EXT_RE's, `README.py` is code. */
const DOCS_NAME_RE = /^(LICENSE|COPYING|NOTICE|AUTHORS|CHANGELOG|README)([-_][^.]*)?$/i;
/** `.txt` files that are build or dependency manifests, not prose: `CMakeLists.txt`, `requirements-dev.txt`, `constraints.txt`. */
const MANIFEST_TXT_RE = /^(CMakeLists\.txt|(requirements|constraints)[^/]*\.txt)$/i;
/**
 * A directory segment whose files a build or a test run reads: test data (golden files, fixtures and snapshots, as in
 * `tests/fixtures/expected.txt` or `__snapshots__/a.png`) and pip-tools' `requirements/` directory (`requirements/base.txt`).
 */
const READ_DIR_RE = /^(tests?|spec|__snapshots__|fixtures|testdata|requirements)$/i;

/**
 * A change to docs alone: every path is prose, markup or an image by its extension, or a project document by its base
 * name (`LICENSE`, `COPYING-GPL`, `README`). A build or dependency manifest with a `.txt` name (`CMakeLists.txt`,
 * `requirements*.txt`, `constraints*.txt`, anything under `requirements/`) and any file under a test-data directory
 * (`test/`, `tests/`, `spec/`, `__snapshots__/`, `fixtures/`, `testdata/`) is not docs: a build or a test run reads them.
 * False for an empty list.
 */
export function isDocsOnlyChange(paths: readonly string[]): boolean {
  if (paths.length === 0) return false;
  return paths.every((p) => {
    const segs = p.replace(/\\/g, '/').split('/');
    const base = segs[segs.length - 1] ?? '';
    if (MANIFEST_TXT_RE.test(base)) return false;
    if (segs.slice(0, -1).some((s) => READ_DIR_RE.test(s))) return false;
    return DOCS_EXT_RE.test(base) || DOCS_NAME_RE.test(base);
  });
}
