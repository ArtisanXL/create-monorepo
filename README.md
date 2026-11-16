# ts-monorepo-scaffold

Ajanlarla (Claude Code) geliştirmeye uygun, korkuluklu bir TypeScript monorepo iskeleti üretir.

```bash
./scaffold-monorepo.sh <hedef-klasör> [--scope @app] [--no-install]
```

- **Yığın:** pnpm (catalog, strict) · Turborepo · TypeScript 7 · Biome · Vitest · Hono (RPC + Zod validator) · Drizzle + postgres.js · pg-boss · React + Vite + TanStack Query · tsdown
- **Paketler:** `apps/{api,web,worker}`, `packages/{domain,contracts,db,core}`. Sürümler çalıştırma anında npm'den en güncel stabil olarak çekilir.
- **Mimari sözleşme:** `architecture.json` (izinli paketler, bağımlılık matrisi, ertelenmiş paketler/bağımlılıklar, korunan yollar), `scripts/arch-check.mjs` ile zorlanır (`pnpm arch`).
- **Ajan korkulukları:** `.claude/hooks/guard.mjs` (PreToolUse) şunları engeller: korunan dosyalara yazma, tanımsız veya ertelenmiş paket açma, ertelenmiş bağımlılık kurma, `--no-verify`. Stop hook'u, mimari ve lint kontrolleri geçmeden işin bitmesine izin vermez. Aynı kontroller pre-commit'te ve CI'da da çalışır.
- **İdempotent:** Mevcut dosyalara dokunulmaz, yalnızca eksik olanlar oluşturulur. `CLAUDE.md`'ye işaretli bir kural bloğu bir kez eklenir ve mevcut içerik korunur. Blok, hook ve sha256 kontrolüyle korunur; bloğun dışı serbestçe düzenlenebilir.

Gereksinimler: Node ≥ 24, pnpm, git, perl. Postgres için `docker compose up -d`.
