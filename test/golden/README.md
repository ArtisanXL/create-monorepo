# Golden output

`<adapter>.golden.txt` pins the full scaffold output for one package-manager adapter
(sorted paths, each as a `=== <path> ===` header followed by the file verbatim; modes excluded).
`test/golden.test.ts` fails on any byte change, added file or removed file.

After an intentional template or output change, regenerate and review the diff:

    pnpm test -u

To add an adapter (e.g. bun), add one row to `GOLDEN_CASES` and run `pnpm test -u`.
Files are LF-only; `.gitattributes` enforces this on Windows checkouts.
