# Golden output

`<adapter>.golden.txt` pins the full scaffold output for one package-manager adapter
(sorted paths, each as a `=== <path> (<n> bytes) ===` header followed by the file verbatim and a newline separator; modes excluded; the byte count makes a missing or extra final newline visible).
`test/golden.test.ts` fails on any byte change, added file or removed file.

After an intentional template or output change, regenerate and review the diff:

    pnpm vitest run test/golden.test.ts -u

(`pnpm test -u` also works but rewrites snapshots for every suite.)

To add an adapter (e.g. bun), add one row to `GOLDEN_CASES` and run `pnpm test -u`.
Files are LF-only; `.gitattributes` enforces this on Windows checkouts.

Files are read as UTF-8; a binary template would need a hash-based entry instead (none exist today).
