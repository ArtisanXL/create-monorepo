#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Modern TS monorepo scaffold — "orta yol" + ajan korkulukları
#
#   ./scaffold-monorepo.sh <hedef-klasör> [--scope @app] [--no-install]
#
# Üretilen yapı:
#   apps/{api,web,worker}  packages/{domain,contracts,db,core}
#   architecture.json      → izinli paketler, bağımlılık matrisi, ertelenmiş paketler
#   scripts/arch-check.mjs → matrisi package.json + import seviyesinde zorlar
#   .claude/hooks          → ajan: korunan dosyalar / tanımsız paket / ertelenmiş bağımlılık engeli
#   .githooks + CI         → aynı kontroller her ajan/insan için
# Sürümler scaffold anında npm'den en güncel stabil olarak çekilir (pnpm catalog).
# ---------------------------------------------------------------------------
set -euo pipefail

TARGET=""
SCOPE="@app"
INSTALL=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --scope) SCOPE="$2"; shift 2 ;;
    --no-install) INSTALL=0; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) TARGET="$1"; shift ;;
  esac
done
[[ -n "$TARGET" ]] || { echo "Kullanım: $0 <hedef-klasör> [--scope @app] [--no-install]" >&2; exit 1; }
[[ "$SCOPE" == @* ]] || { echo "--scope '@' ile başlamalı" >&2; exit 1; }

# İdempotent: mevcut dosyalara asla dokunulmaz; yalnızca eksikler oluşturulur.
# CLAUDE.md'ye işaretli bir blok bir kez eklenir; mevcut içerik korunur.
WRITTEN=()
emit() { # kullanım: emit <yol> <<'EOF' ... EOF
  if [[ -e "$1" ]]; then
    echo "  = $1 (mevcut, atlandı)"
    cat >/dev/null
    return 0
  fi
  mkdir -p "$(dirname "$1")"
  cat >"$1"
  WRITTEN+=("$1")
}

CLAUDE_BEGIN="<!-- scaffold:begin — bu blok scaffold-monorepo.sh tarafından eklendi -->"
CLAUDE_END="<!-- scaffold:end -->"
upsert_claude_md() { # blok stdin'den; varsa tekrar yazılmaz
  local block
  block="$(cat)"
  block="${block//__SCOPE__/$SCOPE}"
  if [[ -f CLAUDE.md ]] && grep -qF "<!-- scaffold:begin" CLAUDE.md; then
    echo "  = CLAUDE.md (scaffold bloğu zaten var, atlandı)"
    return 0
  fi
  {
    if [[ -s CLAUDE.md ]]; then
      [[ "$(tail -c1 CLAUDE.md)" == "" ]] || printf '\n'
      printf '\n'
    fi
    printf '%s\n%s\n%s\n' "$CLAUDE_BEGIN" "$block" "$CLAUDE_END"
  } >>CLAUDE.md
  echo "  + CLAUDE.md (scaffold bloğu eklendi)"
}

for bin in node pnpm git perl; do
  command -v "$bin" >/dev/null || { echo "Gerekli araç yok: $bin" >&2; exit 1; }
done
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 24 )) || { echo "Node >= 24 gerekli (bulunan: $NODE_MAJOR)" >&2; exit 1; }
PNPM_VERSION="$(pnpm -v)"

mkdir -p "$TARGET"
cd "$TARGET"

# --- Sürümler (pnpm catalog) ------------------------------------------------
CATALOG_YAML=""
if [[ ! -e pnpm-workspace.yaml ]]; then
echo "→ Güncel sürümler çözülüyor..."
CATALOG_PKGS=(
  typescript @biomejs/biome turbo vitest tsx tsdown
  zod hono @hono/node-server @hono/zod-validator
  drizzle-orm drizzle-kit postgres pg-boss
  react react-dom @types/react @types/react-dom vite @vitejs/plugin-react @tanstack/react-query
)
for p in "${CATALOG_PKGS[@]}"; do
  v="$(pnpm view "$p" version 2>/dev/null | tail -n1)"
  [[ -n "$v" ]] || { echo "Sürüm çözülemedi: $p" >&2; exit 1; }
  if [[ "$p" == typescript ]]; then spec="~$v"; else spec="^$v"; fi
  CATALOG_YAML+="  \"$p\": \"$spec\""$'\n'
done
CATALOG_YAML+="  \"@types/node\": \"^$NODE_MAJOR\""$'\n'
fi

mkdir -p apps/{api,web,worker}/src packages/{domain,contracts,db,core}/src \
  scripts docs/adr/proposed .claude/hooks .githooks .github/workflows

# --- Kök dosyalar -----------------------------------------------------------
emit pnpm-workspace.yaml <<EOF
packages:
  - "apps/*"
  - "packages/*"

# Tüm harici sürümler burada; package.json'larda yalnızca "catalog:" kullanılır.
catalogMode: strict
catalog:
${CATALOG_YAML}
# Kurulum script'i çalıştırmasına izin verilen paketler
allowBuilds:
  esbuild: true
EOF

emit package.json <<'EOF'
{
  "name": "__SCOPE__/root",
  "private": true,
  "type": "module",
  "engines": { "node": ">=__NODE_MAJOR__" },
  "packageManager": "pnpm@__PNPM__",
  "scripts": {
    "prepare": "git config core.hooksPath .githooks || true",
    "dev": "turbo run dev",
    "build": "turbo run build",
    "typecheck": "turbo run typecheck",
    "test": "vitest run",
    "lint": "biome check .",
    "format": "biome check --write .",
    "arch": "node scripts/arch-check.mjs",
    "verify": "pnpm arch && pnpm lint && pnpm typecheck && pnpm test",
    "db:generate": "pnpm --filter __SCOPE__/db generate",
    "db:migrate": "pnpm --filter __SCOPE__/db migrate"
  },
  "devDependencies": {
    "@biomejs/biome": "catalog:",
    "@types/node": "catalog:",
    "turbo": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
EOF

emit turbo.json <<'EOF'
{
  "$schema": "https://turborepo.com/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "typecheck": { "dependsOn": ["^typecheck"] },
    "dev": { "cache": false, "persistent": true }
  }
}
EOF

emit tsconfig.base.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["ES2024"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "types": ["node"]
  }
}
EOF

emit biome.json <<'EOF'
{
  "$schema": "./node_modules/@biomejs/biome/configuration_schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "includes": ["**", "!**/migrations", "!**/*.md"] },
  "formatter": { "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": {
    "enabled": true,
    "rules": {
      "preset": "recommended",
      "suspicious": { "noExplicitAny": "error" },
      "style": { "noNonNullAssertion": "error" }
    }
  }
}
EOF

emit vitest.config.ts <<'EOF'
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*"],
    passWithNoTests: true,
  },
});
EOF

emit .gitignore <<'EOF'
node_modules
dist
.turbo
coverage
.env
.env.*
!.env.example
*.tsbuildinfo
EOF

emit .editorconfig <<'EOF'
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
insert_final_newline = true
trim_trailing_whitespace = true
EOF

emit .nvmrc <<<"$NODE_MAJOR"

emit .env.example <<'EOF'
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://app:app@localhost:5432/app
EOF

emit compose.yaml <<'EOF'
services:
  postgres:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
    ports: ["5432:5432"]
    volumes: [pgdata:/var/lib/postgresql]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app"]
      interval: 5s
      retries: 10
volumes:
  pgdata: {}
EOF

# --- Mimari sözleşme ----------------------------------------------------------
emit architecture.json <<'EOF'
{
  "$comment": "Tek doğruluk kaynağı. Yalnızca insanlar değiştirir (ajan hook'u + CODEOWNERS). Her değişiklik kabul edilmiş bir ADR gerektirir.",
  "scope": "__SCOPE__",
  "test_allow": ["vitest"],
  "packages": {
    "packages/domain": {
      "adr": "docs/adr/0001-paket-sinirlari.md",
      "role": "Saf iş kuralları ve değer nesneleri (Money vb.). I/O yok.",
      "may_depend_on": [],
      "external_allow": []
    },
    "packages/contracts": {
      "adr": "docs/adr/0001-paket-sinirlari.md",
      "role": "API girdi/çıktı Zod şemaları. Doğrulama kuralları yalnızca burada.",
      "may_depend_on": [],
      "external_allow": ["zod"]
    },
    "packages/db": {
      "adr": "docs/adr/0001-paket-sinirlari.md",
      "role": "Drizzle şeması, migration'lar, DB istemcisi.",
      "may_depend_on": ["packages/domain"],
      "external_allow": ["drizzle-orm", "drizzle-kit", "postgres"]
    },
    "packages/core": {
      "adr": "docs/adr/0001-paket-sinirlari.md",
      "role": "Use-case'ler (actions/queries). HTTP/kuyruk bilmez.",
      "may_depend_on": ["packages/domain", "packages/contracts", "packages/db"]
    },
    "apps/api": {
      "adr": "docs/adr/0001-paket-sinirlari.md",
      "role": "Hono HTTP katmanı: doğrulama + core çağrısı. İş kuralı yazılmaz.",
      "may_depend_on": ["packages/core", "packages/contracts", "packages/domain", "packages/db"]
    },
    "apps/worker": {
      "adr": "docs/adr/0003-is-kuyrugu-pg-boss.md",
      "role": "pg-boss arka plan işleri: core çağrısı. İş kuralı yazılmaz.",
      "may_depend_on": ["packages/core", "packages/domain", "packages/db"]
    },
    "apps/web": {
      "adr": "docs/adr/0001-paket-sinirlari.md",
      "role": "React SPA. API'ye yalnızca hc<AppType> istemcisiyle erişir.",
      "may_depend_on": ["packages/contracts", "packages/domain"],
      "type_only": ["apps/api"]
    }
  },
  "deferred": [
    {
      "name": "auth",
      "path": "packages/auth",
      "trigger": "Gerçek kullanıcı girişi bir gereksinim olduğunda (tercih: better-auth).",
      "deps": ["better-auth", "lucia", "next-auth", "@auth/core", "passport", "jsonwebtoken", "jose"]
    },
    {
      "name": "i18n",
      "path": "packages/i18n",
      "trigger": "İkinci bir arayüz dili istendiğinde.",
      "deps": ["i18next", "react-i18next", "@lingui/core", "@lingui/react", "react-intl", "@inlang/paraglide-js"]
    },
    {
      "name": "ui",
      "path": "packages/ui",
      "trigger": "Aynı bileşenleri kullanan ikinci bir uygulama oluştuğunda.",
      "deps": []
    },
    {
      "name": "config",
      "path": "packages/config",
      "trigger": "Aynı env şeması üçüncü bir uygulamada tekrarlandığında.",
      "deps": ["@t3-oss/env-core", "dotenv", "convict"]
    },
    {
      "name": "integrations",
      "path": "packages/integrations",
      "trigger": "İlk üçüncü parti API entegrasyonu onaylandığında.",
      "deps": []
    },
    {
      "name": "crawler",
      "path": "apps/crawler",
      "trigger": "Resmi API ile karşılanamayan bir veri ihtiyacı (ToS) onaylandığında.",
      "deps": ["crawlee", "playwright", "puppeteer", "cheerio"]
    },
    {
      "name": "e2e",
      "path": "apps/e2e",
      "trigger": "İlk kritik kullanıcı akışı tamamlandığında.",
      "deps": ["@playwright/test", "cypress"]
    },
    {
      "name": "redis-queue",
      "path": null,
      "trigger": "pg-boss ölçülmüş bir throughput sınırına takıldığında.",
      "deps": ["bullmq", "bull", "ioredis", "redis"]
    }
  ],
  "protected_paths": [
    "architecture.json",
    "docs/adr/",
    "scripts/arch-check.mjs",
    ".claude/settings.json",
    ".claude/hooks/",
    ".githooks/",
    ".github/",
    "biome.json",
    "tsconfig.base.json",
    "turbo.json",
    "vitest.config.ts"
  ],
  "agent_writable_exceptions": ["docs/adr/proposed/"],
  "claude_md_block": {
    "$comment": "CLAUDE.md'deki scaffold bloğu korunur; bloğun dışı serbesttir. Bloğu bir insan değiştirirse sha256 da güncellenir.",
    "begin": "<!-- scaffold:begin",
    "end": "<!-- scaffold:end -->",
    "sha256": "__CLAUDE_SHA__"
  }
}
EOF

# --- ADR'ler ------------------------------------------------------------------
emit docs/adr/TEMPLATE.md <<'EOF'
# NNNN. Başlık

- Durum: önerildi | kabul edildi | yerini aldı: NNNN
- Tarih: YYYY-AA-GG

## Bağlam
## Karar
## Sonuçlar
## architecture.json değişikliği
```json
```
EOF

emit docs/adr/0001-paket-sinirlari.md <<'EOF'
# 0001. Paket sınırları

- Durum: kabul edildi

## Karar
Monorepo yalnızca `architecture.json`'da listelenen paketlerden oluşur. Bağımlılık yönü:

```
web ──(yalnızca import type)──▶ api ──▶ core ──▶ db ──▶ domain
 │                               │       └────▶ contracts
 └──▶ contracts, domain          └──▶ contracts
worker ──▶ core, db, domain
```

- `domain` hiçbir pakete ve harici kütüphaneye bağımlı değildir.
- `contracts` yalnızca `zod`'a bağımlıdır; doğrulama kuralları yalnızca burada yazılır.
- `api`/`worker` iş kuralı içermez; `core` use-case'lerini çağırır. `db`'yi yalnızca bağlantıyı kurmak (composition root) için import eder.
- `web` API'ye yalnızca `hc<AppType>` ile erişir; `db`/`core` import etmez.
- Paketler arası göreli import (`../../packages/...`) yasaktır.

## Zorlama
`scripts/arch-check.mjs` (`pnpm arch`): klasör listesi, paket adları, package.json bağımlılıkları,
kaynak import'ları, ertelenmiş bağımlılıklar, `@ts-ignore`/`@ts-nocheck`, boş placeholder dosyalar.
Pre-commit hook, CI ve Claude Code Stop hook'u bu kontrolü çalıştırır.
EOF

emit docs/adr/0002-ertelenmis-paketler.md <<'EOF'
# 0002. İhtiyaç doğana kadar ertelenen paketler

- Durum: kabul edildi

## Bağlam
Boş paketler ve `.gitkeep` klasörleri ajanlara "burayı doldur" sinyali verir ve spekülatif kod üretir.

## Karar
`architecture.json > deferred` listesindeki paketler ve bağımlılıklar, tetikleyici koşul gerçekleşip
bir ADR kabul edilene kadar **oluşturulmaz/kurulmaz**. Boş placeholder dosya (`.gitkeep`) yasaktır.

## Süreç
1. Ajan veya geliştirici ihtiyacı fark eder.
2. `docs/adr/proposed/NNNN-baslik.md` altına `TEMPLATE.md`'ye göre taslak yazar (ajanların yazabildiği tek ADR yolu).
3. Bir insan taslağı inceler; kabul ederse `docs/adr/` altına taşır ve `architecture.json`'u günceller.
4. Ancak bundan sonra paket/bağımlılık eklenir.
EOF

emit docs/adr/0003-is-kuyrugu-pg-boss.md <<'EOF'
# 0003. Arka plan işleri için pg-boss

- Durum: kabul edildi

## Karar
Kuyruk olarak Postgres üzerinde çalışan `pg-boss` kullanılır; ek altyapı (Redis) gerekmez ve iş
kuyruğa alma, iş verisiyle aynı transaction içinde yapılabilir. Redis tabanlı kuyruklar
(`bullmq` vb.) ölçülmüş bir throughput sınırına kadar ertelenmiştir (bkz. 0002).
EOF

emit docs/adr/proposed/README.md <<'EOF'
Ajanların ve geliştiricilerin ADR **taslakları** buraya yazılır. Buradaki hiçbir dosya kabul edilmiş
sayılmaz ve `architecture.json` tarafından referans verilemez.
EOF

# --- Ajan talimatları ---------------------------------------------------------
upsert_claude_md <<'EOF'
# Proje kuralları

Bu blok `.claude/hooks/guard.mjs` ve `pnpm arch` tarafından korunur. Bloğun dışına serbestçe yazılabilir.

## Komutlar
- `pnpm verify`: mimari, lint, typecheck ve testler. **Bir iş ancak bu komut geçince bitmiş sayılır.**
- `pnpm dev`: tüm uygulamalar. `docker compose up -d` ile Postgres.
- `pnpm arch`: yalnızca mimari kontrol.
- `pnpm add <paket> --filter __SCOPE__/<hedef>`: bağımlılık ekleme. Sürüm otomatik olarak catalog'a yazılır.

## Kod nereye gider
| İhtiyaç | Yer |
|---|---|
| İş kuralı, hesaplama, değer nesnesi | `packages/domain` |
| İstek/yanıt şeması, doğrulama | `packages/contracts` (Zod) |
| Tablo, migration, sorgu yardımcısı | `packages/db` |
| Use-case (domain + db orkestrasyonu) | `packages/core` |
| HTTP endpoint | `apps/api/src/app.ts` (yalnızca doğrulama + core çağrısı) |
| Arka plan işi | `apps/worker/src/jobs/` (yalnızca core çağrısı) |
| Arayüz | `apps/web` (API'ye `src/lib/api.ts` üzerinden erişilir) |

Bağımlılık yönü ve paket rolleri: `architecture.json` ve `docs/adr/0001-paket-sinirlari.md`.

## Kesin kurallar
1. **Yeni paket veya klasör açılmaz.** `apps/` ve `packages/` altında yalnızca `architecture.json`'daki paketler bulunur.
2. **Ertelenmiş işler yapılmaz.** `architecture.json > deferred` listesindeki paketler (auth, i18n, ui, config, integrations, crawler, e2e) ve bağımlılıklar tetikleyici koşul gerçekleşmeden eklenmez. Gerekli olduğunu düşünüyorsan **dur**, `docs/adr/proposed/` altına `docs/adr/TEMPLATE.md`'ye göre bir taslak yaz ve kullanıcıya sor.
3. **Korunan dosyalar değiştirilmez:** `architecture.json > protected_paths` ve bu blok. Yalnızca insanlar değiştirir.
4. Kural susturulmaz: `@ts-ignore`, `@ts-nocheck`, `--no-verify` yasak. `biome-ignore` kullanılacaksa gerekçesi yazılır.
5. Para her zaman `domain`'deki `Money` tipiyle (`bigint` + para birimi) tutulur; `number` kullanılmaz.
6. Göreli importlarda `.ts` uzantısı yazılır (`./foo.ts`).
7. Boş placeholder dosya/klasör (`.gitkeep`, `export {}`) oluşturulmaz. Kod, ihtiyaç olduğunda yazılır.
EOF

# --- Mimari kontrol script'i ---------------------------------------------------
emit scripts/arch-check.mjs <<'EOF'
#!/usr/bin/env node
// architecture.json'daki sözleşmeyi zorlar. Bağımlılıksız; TS derleyici API'sine ihtiyaç duymaz.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const arch = JSON.parse(readFileSync(path.join(root, "architecture.json"), "utf8"));

/** CLAUDE.md'deki scaffold bloğunun (işaretler dahil) sha256'sı; blok yoksa null. */
function claudeBlockHash() {
  const cb = arch.claude_md_block;
  const p = path.join(root, "CLAUDE.md");
  if (!cb || !existsSync(p)) return null;
  const text = readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const b = text.indexOf(cb.begin);
  const e = b < 0 ? -1 : text.indexOf(cb.end, b);
  if (e < 0) return null;
  return createHash("sha256").update(text.slice(b, e + cb.end.length)).digest("hex");
}
// İnsan bloğu bilerek değiştirdiyse: `pnpm arch --claude-hash` → architecture.json'a yazın.
if (process.argv.includes("--claude-hash")) {
  console.log(claudeBlockHash() ?? "CLAUDE.md scaffold bloğu bulunamadı");
  process.exit(0);
}

const { scope, packages } = arch;
const deferred = arch.deferred ?? [];
const testAllow = new Set(arch.test_allow ?? []);
const errors = [];
const err = (m) => errors.push(m);
const rel = (p) => path.relative(root, p).split(path.sep).join("/");

const nameToDir = new Map(Object.keys(packages).map((d) => [`${scope}/${path.basename(d)}`, d]));
const deferredByPath = new Map(deferred.filter((d) => d.path).map((d) => [d.path, d]));
const forbiddenDeps = new Map(deferred.flatMap((d) => (d.deps ?? []).map((dep) => [dep, d])));
const hint = (d) =>
  `ertelenmiş "${d.name}" kapsamında. Tetikleyici: ${d.trigger} Gerekliyse docs/adr/proposed/ altına ADR taslağı yazıp insan onayı isteyin.`;
const pkgNameOf = (spec) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name === ".turbo") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const inner = readdirSync(p);
      if (inner.length === 0) err(`${rel(p)}: boş klasör (placeholder yasak)`);
      yield* walk(p);
    } else yield p;
  }
}

// 1) apps/ ve packages/ altında yalnızca tanımlı paketler
for (const group of ["apps", "packages"]) {
  const g = path.join(root, group);
  if (!existsSync(g)) continue;
  for (const e of readdirSync(g, { withFileTypes: true })) {
    const dir = `${group}/${e.name}`;
    if (packages[dir]) continue;
    const d = deferredByPath.get(dir);
    err(`${dir}: architecture.json'da tanımlı değil — ${d ? hint(d) : "yeni paket yalnızca kabul edilmiş bir ADR ile eklenebilir."}`);
  }
}

// 2) Ertelenmiş bağımlılıklar hiçbir yerde olmamalı (kök + catalog dahil)
const depsOf = (pj) => ({ ...pj.dependencies, ...pj.devDependencies, ...pj.peerDependencies, ...pj.optionalDependencies });
const rootPj = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
for (const dep of Object.keys(depsOf(rootPj))) {
  const d = forbiddenDeps.get(dep);
  if (d) err(`package.json → ${dep}: ${hint(d)}`);
}
const ws = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
for (const [dep, d] of forbiddenDeps) {
  const re = new RegExp(`^\\s+["']?${dep.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}["']?\\s*:`, "m");
  if (re.test(ws)) err(`pnpm-workspace.yaml catalog → ${dep}: ${hint(d)}`);
}

// 3) Paket başına kontroller
const IMPORT_RE =
  /(?:^|[\s;])(import|export)\s+(type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

for (const [dir, spec] of Object.entries(packages)) {
  const abs = path.join(root, dir);
  const pjPath = path.join(abs, "package.json");
  if (!existsSync(pjPath)) {
    err(`${dir}: package.json yok`);
    continue;
  }
  if (!spec.adr || spec.adr.includes("/proposed/") || !existsSync(path.join(root, spec.adr)))
    err(`${dir}: kabul edilmiş ADR referansı eksik veya geçersiz (${spec.adr ?? "-"})`);

  const pj = JSON.parse(readFileSync(pjPath, "utf8"));
  const expected = `${scope}/${path.basename(dir)}`;
  if (pj.name !== expected) err(`${dir}: paket adı "${expected}" olmalı (bulunan: ${pj.name})`);

  const mayDepend = new Set(spec.may_depend_on ?? []);
  const typeOnly = new Set(spec.type_only ?? []);
  const extAllow = spec.external_allow ? new Set(spec.external_allow) : null;

  for (const dep of Object.keys(depsOf(pj))) {
    const target = nameToDir.get(dep);
    if (target) {
      if (!mayDepend.has(target) && !typeOnly.has(target))
        err(`${dir} → ${dep}: bu bağımlılığa izin yok (izinli: ${[...mayDepend, ...typeOnly].join(", ") || "hiçbiri"})`);
    } else if (dep.startsWith(`${scope}/`)) err(`${dir} → ${dep}: bilinmeyen workspace paketi`);
    else if (forbiddenDeps.has(dep)) err(`${dir} → ${dep}: ${hint(forbiddenDeps.get(dep))}`);
    else if (extAllow && !extAllow.has(dep) && !testAllow.has(dep))
      err(`${dir} → ${dep}: harici bağımlılık izinli listede değil (${[...extAllow].join(", ") || "hiçbiri"})`);
  }

  for (const file of walk(abs)) {
    const r = rel(file);
    if (path.basename(file) === ".gitkeep") err(`${r}: placeholder dosya yasak`);
    if (!/\.(ts|tsx|mts|cts|js|mjs|jsx)$/.test(file)) continue;
    const src = readFileSync(file, "utf8");
    if (/@ts-(ignore|nocheck)/.test(src)) err(`${r}: @ts-ignore / @ts-nocheck yasak`);
    if (/^\s*export\s*\{\s*\}\s*;?\s*$/.test(src)) err(`${r}: boş modül (export {}) — placeholder yasak`);
    const isTest = /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);

    for (const m of src.matchAll(IMPORT_RE)) {
      const isType = Boolean(m[2]);
      const s = m[3] ?? m[4];
      if (!s) continue;
      if (s.startsWith(".")) {
        const resolved = path.resolve(path.dirname(file), s);
        if (!resolved.startsWith(abs + path.sep)) err(`${r}: paket dışına göreli import yasak ("${s}")`);
        continue;
      }
      const name = pkgNameOf(s);
      if (name.startsWith(`${scope}/`)) {
        const target = nameToDir.get(name);
        if (!target) err(`${r}: bilinmeyen workspace paketi "${name}"`);
        else if (target === dir) err(`${r}: paket kendi adıyla import edilmemeli ("${s}")`);
        else if (typeOnly.has(target) && !isType) err(`${r}: "${name}" yalnızca \`import type\` ile import edilebilir`);
        else if (!mayDepend.has(target) && !typeOnly.has(target)) err(`${r}: "${name}" import'una izin yok`);
        continue;
      }
      if (forbiddenDeps.has(name)) {
        err(`${r}: "${name}" ${hint(forbiddenDeps.get(name))}`);
        continue;
      }
      if (extAllow && !(isTest && testAllow.has(name))) {
        const ok = s.startsWith("node:") ? extAllow.has("node:*") : extAllow.has(name);
        if (!ok) err(`${r}: "${s}" import'una izin yok (${dir} izinli harici: ${[...extAllow].join(", ") || "hiçbiri"})`);
      }
    }
  }
}

// 4) CLAUDE.md scaffold bloğu yerinde ve değiştirilmemiş olmalı (bloğun dışı serbest)
if (arch.claude_md_block) {
  const h = claudeBlockHash();
  if (!h) err("CLAUDE.md: scaffold bloğu eksik");
  else if (h !== arch.claude_md_block.sha256)
    err("CLAUDE.md: scaffold bloğu değiştirilmiş. Yalnızca insanlar değiştirir; bilerek değiştirdiyseniz `pnpm arch --claude-hash` çıktısını architecture.json > claude_md_block.sha256'ya yazın.");
}

if (errors.length) {
  console.error(`✗ Mimari kontrol başarısız (${errors.length}):\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  console.error("\nKurallar: CLAUDE.md, architecture.json, docs/adr/");
  process.exit(1);
}
console.log(`✓ Mimari kontrol geçti (${Object.keys(packages).length} paket)`);
EOF

# --- Claude Code hook'ları -------------------------------------------------------
emit .claude/settings.json <<'EOF'
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|NotebookEdit|Bash",
        "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/guard.mjs" }]
      }
    ],
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR\"/.claude/hooks/stop-check.mjs" }]
      }
    ]
  }
}
EOF

emit .claude/hooks/guard.mjs <<'EOF'
#!/usr/bin/env node
// PreToolUse: korunan dosyalara yazma, tanımsız paket açma, ertelenmiş bağımlılık kurma ve
// hook atlama girişimlerini engeller (exit 2 → işlem iptal, mesaj ajana iletilir).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const arch = JSON.parse(readFileSync(path.join(root, "architecture.json"), "utf8"));
const allowed = new Set(Object.keys(arch.packages));
const deferred = arch.deferred ?? [];
const protectedPaths = arch.protected_paths ?? [];
const exceptions = arch.agent_writable_exceptions ?? [];

const block = (msg) => {
  process.stderr.write(`⛔ ${msg}\nKurallar: CLAUDE.md ve architecture.json.\n`);
  process.exit(2);
};
const hint = (d) =>
  `Bu, ertelenmiş "${d.name}" kapsamında (tetikleyici: ${d.trigger}). Gerekli olduğunu düşünüyorsan dur, docs/adr/proposed/ altına bir ADR taslağı yaz ve kullanıcıya sor.`;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const isProtected = (r) =>
  !exceptions.some((e) => r.startsWith(e)) &&
  protectedPaths.some((p) => (p.endsWith("/") ? r.startsWith(p) : r === p));

function checkPath(r) {
  if (r.startsWith("..") || path.isAbsolute(r)) return;
  if (isProtected(r))
    block(`${r} korunan bir dosya; yalnızca insanlar değiştirebilir. Değişiklik gerekiyorsa docs/adr/proposed/ altına ADR taslağı yaz ve kullanıcıya sor.`);
  const m = r.match(/^(apps|packages)\/([^/]+)/);
  if (m && !allowed.has(`${m[1]}/${m[2]}`)) {
    const dir = `${m[1]}/${m[2]}`;
    const d = deferred.find((x) => x.path === dir);
    block(`${dir} architecture.json'da tanımlı bir paket değil. ${d ? hint(d) : "Yeni paket açmak kabul edilmiş bir ADR gerektirir."}`);
  }
}

const tool = input.tool_name;
const ti = input.tool_input ?? {};

/** CLAUDE.md: scaffold bloğuna dokunan düzenlemeleri engeller, bloğun dışı serbesttir. */
function checkClaudeMd() {
  const cb = arch.claude_md_block;
  const p = path.join(root, "CLAUDE.md");
  if (!cb || !existsSync(p)) return;
  const text = readFileSync(p, "utf8");
  const b = text.indexOf(cb.begin);
  const e = b < 0 ? -1 : text.indexOf(cb.end, b);
  if (e < 0) return;
  const end = e + cb.end.length;
  const msg = "CLAUDE.md'deki scaffold bloğu korunuyor; yalnızca bloğun dışını düzenleyebilirsin.";
  if (tool === "Write") {
    if (!String(ti.content ?? "").includes(text.slice(b, end))) block(msg);
    return;
  }
  const edits = tool === "MultiEdit" ? (ti.edits ?? []) : [ti];
  for (const ed of edits) {
    const old = String(ed.old_string ?? "");
    if (!old) continue;
    for (let i = text.indexOf(old); i >= 0; i = text.indexOf(old, i + 1))
      if (i < end && i + old.length > b) block(msg);
  }
}

if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
  const fp = ti.file_path ?? ti.notebook_path;
  if (fp) {
    const r = path.relative(root, path.resolve(root, fp)).split(path.sep).join("/");
    checkPath(r);
    if (r === "CLAUDE.md") checkClaudeMd();
  }
}

if (tool === "Bash") {
  const cmd = String(ti.command ?? "");
  if (
    /CLAUDE\.md/.test(cmd) &&
    (/\b(sed\s+-i|perl\s+-p?i|rm|mv|cp|truncate)\b/.test(cmd) ||
      /(^|[^>])>\s*["']?\S*CLAUDE\.md/.test(cmd) ||
      /\btee\s+(?!-a)\S*CLAUDE\.md/.test(cmd))
  )
    block("CLAUDE.md Bash ile değiştirilemez; Edit aracıyla yalnızca scaffold bloğunun dışını düzenle.");
  if (/--no-verify\b/.test(cmd) || /\bgit\s+commit\b[^|;&]*\s-n\b/.test(cmd))
    block("Git hook'larını atlamak yasak (--no-verify).");
  if (/core\.hooksPath/.test(cmd) && !/\.githooks/.test(cmd)) block("Git hook yolunu değiştirmek yasak.");

  if (/\b(pnpm|npm|yarn|bun)\s+(add|install|i|update|up)\b/.test(cmd)) {
    for (const d of deferred)
      for (const dep of d.deps ?? [])
        if (new RegExp(`(^|[\\s"'])${esc(dep)}(@[^\\s"']*)?(?=$|[\\s"'])`).test(cmd))
          block(`"${dep}" kurulamaz. ${hint(d)}`);
  }

  const writes = /\b(mkdir|touch|cp|mv|rm|tee|truncate|ln|install)\b|\bsed\s+-i|\bperl\s+-p?i|>/.test(cmd);
  if (writes) {
    for (const p of protectedPaths) {
      const needle = p.replace(/\/$/, "");
      if (new RegExp(`(^|[\\s"'=/])${esc(needle)}($|[\\s"'/])`).test(cmd) && !exceptions.some((e) => cmd.includes(e)))
        block(`Komut korunan bir yola dokunuyor (${p}); yalnızca insanlar değiştirebilir.`);
    }
    for (const m of cmd.matchAll(/(?:^|[\s"'=/])((?:apps|packages)\/[A-Za-z0-9._-]+)/g)) checkPath(m[1]);
  }
}

process.exit(0);
EOF

emit .claude/hooks/stop-check.mjs <<'EOF'
#!/usr/bin/env node
// Stop: ajan işi bitirmeden önce mimari + lint kontrolleri geçmeli (exit 2 → ajan devam eder).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
if (input.stop_hook_active) process.exit(0); // sonsuz döngüyü önle
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const run = (cmd, args) => spawnSync(cmd, args, { cwd: root, encoding: "utf8" });

const checks = [["mimari", run(process.execPath, ["scripts/arch-check.mjs"])]];
const biome = path.join(root, "node_modules", ".bin", "biome");
if (existsSync(biome)) checks.push(["lint", run(biome, ["check", "."])]);

const failed = checks.filter(([, r]) => r.status !== 0);
if (failed.length) {
  const out = failed.map(([n, r]) => `## ${n}\n${r.stdout ?? ""}${r.stderr ?? ""}`).join("\n");
  process.stderr.write(`Bitirmeden önce şu kontrolleri düzelt (pnpm verify):\n${out.slice(-6000)}`);
  process.exit(2);
}
process.exit(0);
EOF

# --- Git hook + CI ----------------------------------------------------------------
emit .githooks/pre-commit <<'EOF'
#!/bin/sh
set -e
pnpm -s arch
pnpm -s lint
EOF
chmod +x .githooks/pre-commit scripts/arch-check.mjs .claude/hooks/*.mjs

emit .github/workflows/ci.yml <<'EOF'
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v5
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm verify
      - run: pnpm build
EOF

emit .github/CODEOWNERS <<'EOF'
# Mimari sözleşme dosyaları insan onayı gerektirir. Aşağıdaki satırlarda
# OWNER yerine GitHub kullanıcı/ekip adını yazıp yorum işaretini kaldırın.
# /architecture.json        OWNER
# /CLAUDE.md                OWNER
# /docs/adr/                OWNER
# /scripts/arch-check.mjs   OWNER
# /.claude/                 OWNER
# /.github/                 OWNER
EOF

# --- Paket yardımcıları --------------------------------------------------------------
lib_pkg() { # $1=dir  $2=deps-json  $3=devdeps-json  $4=extra-scripts-json
  local name deps devdeps scripts
  name="$(basename "$1")"
  deps="${2:-}"; [[ -n "$deps" ]] || deps="{}"
  devdeps="${3:-}"; [[ -n "$devdeps" ]] || devdeps="{}"
  scripts='"typecheck": "tsc -p ."'
  [[ -z "${4:-}" ]] || scripts+=", $4"
  emit "$1/package.json" <<EOF
{
  "name": "__SCOPE__/$name",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { $scripts },
  "dependencies": $deps,
  "devDependencies": $devdeps
}
EOF
  emit "$1/tsconfig.json" <<'EOF'
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "*.config.ts"]
}
EOF
}

# --- packages/domain ---------------------------------------------------------------
lib_pkg packages/domain
mkdir -p packages/domain/src/money
emit packages/domain/src/index.ts <<'EOF'
export * from "./money/money.ts";
EOF
emit packages/domain/src/money/money.ts <<'EOF'
/** Para: en küçük birimde (kuruş/cent) bigint + ISO 4217 para birimi. Asla number kullanılmaz. */
export interface Money {
  readonly amount: bigint;
  readonly currency: string;
}

export class CurrencyMismatchError extends Error {
  override name = "CurrencyMismatchError";
}

const digitsCache = new Map<string, number>();

/** Para biriminin ondalık basamak sayısı (TRY/USD: 2, JPY: 0, KWD: 3). */
export function minorDigits(currency: string): number {
  let digits = digitsCache.get(currency);
  if (digits === undefined) {
    digits =
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2;
    digitsCache.set(currency, digits);
  }
  return digits;
}

export function money(amount: bigint, currency: string): Money {
  const code = currency.toUpperCase();
  minorDigits(code); // geçersiz para biriminde RangeError fırlatır
  return { amount, currency: code };
}

export function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(`${a.currency} ile ${b.currency} toplanamaz`);
  }
  return money(a.amount + b.amount, a.currency);
}

/** Kayıpsız ondalık gösterim: 12345n TRY → "123.45" */
export function toDecimalString(m: Money): string {
  const digits = minorDigits(m.currency);
  const negative = m.amount < 0n;
  const abs = (negative ? -m.amount : m.amount).toString().padStart(digits + 1, "0");
  const whole = digits === 0 ? abs : abs.slice(0, -digits);
  const fraction = digits === 0 ? "" : `.${abs.slice(-digits)}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

export function format(m: Money, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: m.currency }).format(
    toDecimalString(m) as `${number}`,
  );
}
EOF
emit packages/domain/src/money/money.test.ts <<'EOF'
import { describe, expect, it } from "vitest";
import { add, CurrencyMismatchError, format, money, toDecimalString } from "./money.ts";

describe("money", () => {
  it("aynı para biriminde toplar", () => {
    expect(add(money(10n, "TRY"), money(20n, "try"))).toEqual(money(30n, "TRY"));
  });

  it("farklı para birimlerini toplamaz", () => {
    expect(() => add(money(1n, "USD"), money(1n, "TRY"))).toThrow(CurrencyMismatchError);
  });

  it("para biriminin basamak sayısına uyar", () => {
    expect(toDecimalString(money(12345n, "TRY"))).toBe("123.45");
    expect(toDecimalString(money(12345n, "JPY"))).toBe("12345");
    expect(toDecimalString(money(12345n, "KWD"))).toBe("12.345");
    expect(toDecimalString(money(-5n, "USD"))).toBe("-0.05");
  });

  it("2^53 üstünde hassasiyet kaybetmez", () => {
    expect(toDecimalString(money(9007199254740993n, "USD"))).toBe("90071992547409.93");
  });

  it("yerel biçimde gösterir", () => {
    expect(format(money(123456n, "USD"), "en-US")).toBe("$1,234.56");
  });
});
EOF

# --- packages/contracts ------------------------------------------------------------
lib_pkg packages/contracts '{ "zod": "catalog:" }'
emit packages/contracts/src/index.ts <<'EOF'
import { z } from "zod";

export const HealthResponse = z.object({
  status: z.enum(["ok", "degraded"]),
  db: z.enum(["up", "down"]),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const FormatPriceRequest = z.object({
  /** En küçük birimde tamsayı, string olarak (JSON'da bigint taşınamaz). */
  amount: z.string().regex(/^-?\d+$/, "tamsayı olmalı"),
  currency: z.string().length(3),
  locale: z.string().min(2).default("tr-TR"),
});
export type FormatPriceRequest = z.infer<typeof FormatPriceRequest>;

export const FormatPriceResponse = z.object({ formatted: z.string() });
export type FormatPriceResponse = z.infer<typeof FormatPriceResponse>;
EOF

# --- packages/db -------------------------------------------------------------------
lib_pkg packages/db \
  '{ "drizzle-orm": "catalog:", "postgres": "catalog:" }' \
  '{ "drizzle-kit": "catalog:" }' \
  '"generate": "drizzle-kit generate", "migrate": "drizzle-kit migrate"'
mkdir -p packages/db/src/schema
emit packages/db/drizzle.config.ts <<'EOF'
import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL tanımlı değil");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: { url },
});
EOF
emit packages/db/src/schema/index.ts <<'EOF'
// Tablolar bu klasörde, tablo başına bir dosya olarak tanımlanır ve buradan export edilir.
// Örnek: export * from "./products.ts";
export const schemaVersion = 1;
EOF
emit packages/db/src/index.ts <<'EOF'
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.ts";

export function createDb(url: string) {
  const client = postgres(url, { max: 10 });
  return drizzle({ client, schema });
}

export type Db = ReturnType<typeof createDb>;

export async function ping(db: Db): Promise<void> {
  await db.execute(sql`select 1`);
}

export { schema };
EOF

# --- packages/core -----------------------------------------------------------------
lib_pkg packages/core \
  '{ "__SCOPE__/contracts": "workspace:*", "__SCOPE__/db": "workspace:*", "__SCOPE__/domain": "workspace:*" }'
emit packages/core/src/index.ts <<'EOF'
export { checkHealth } from "./queries/health.ts";
export { formatPrice } from "./queries/format-price.ts";
EOF
mkdir -p packages/core/src/queries
emit packages/core/src/queries/health.ts <<'EOF'
import type { HealthResponse } from "__SCOPE__/contracts";
import { type Db, ping } from "__SCOPE__/db";

export async function checkHealth(db: Db): Promise<HealthResponse> {
  try {
    await ping(db);
    return { status: "ok", db: "up" };
  } catch {
    return { status: "degraded", db: "down" };
  }
}
EOF
emit packages/core/src/queries/format-price.ts <<'EOF'
import type { FormatPriceRequest, FormatPriceResponse } from "__SCOPE__/contracts";
import { format, money } from "__SCOPE__/domain";

export function formatPrice(input: FormatPriceRequest): FormatPriceResponse {
  return { formatted: format(money(BigInt(input.amount), input.currency), input.locale) };
}
EOF

# --- apps/api ----------------------------------------------------------------------
node_app_files() { # $1=dir  $2=deps-json  $3=entry
  local name; name="$(basename "$1")"
  emit "$1/package.json" <<EOF
{
  "name": "__SCOPE__/$name",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "dev": "tsx watch --env-file-if-exists=../../.env src/$3.ts",
    "build": "tsdown",
    "start": "node --env-file-if-exists=../../.env dist/$3.mjs",
    "typecheck": "tsc -p ."
  },
  "dependencies": $2,
  "devDependencies": { "tsdown": "catalog:", "tsx": "catalog:" }
}
EOF
  emit "$1/tsconfig.json" <<'EOF'
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "*.config.ts"]
}
EOF
  emit "$1/tsdown.config.ts" <<EOF
import { defineConfig } from "tsdown";

// Workspace paketleri kaynak olarak tüketildiği için çıktıya gömülür.
export default defineConfig({
  entry: ["src/$3.ts"],
  platform: "node",
  format: "esm",
  outDir: "dist",
  noExternal: [/^__SCOPE_RE__\\//],
});
EOF
  emit "$1/src/env.ts" <<'EOF'
import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url(),
});

export type Env = z.infer<typeof Env>;
export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => Env.parse(source);
EOF
}

node_app_files apps/api '{
    "__SCOPE__/contracts": "workspace:*",
    "__SCOPE__/core": "workspace:*",
    "__SCOPE__/db": "workspace:*",
    "@hono/node-server": "catalog:",
    "@hono/zod-validator": "catalog:",
    "hono": "catalog:",
    "zod": "catalog:"
  }' server

emit apps/api/src/index.ts <<'EOF'
// Web yalnızca bu tipi `import type` ile kullanır (hc<AppType>).
export type { AppType } from "./app.ts";
EOF
emit apps/api/src/app.ts <<'EOF'
import { FormatPriceRequest } from "__SCOPE__/contracts";
import { checkHealth, formatPrice } from "__SCOPE__/core";
import type { Db } from "__SCOPE__/db";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";

export interface AppDeps {
  db: Db;
}

/** HTTP katmanı: yalnızca doğrulama + core çağrısı. İş kuralı burada yazılmaz. */
export function createApp({ db }: AppDeps) {
  return new Hono()
    .basePath("/api")
    .get("/health", async (c) => c.json(await checkHealth(db)))
    .post("/format-price", zValidator("json", FormatPriceRequest), (c) =>
      c.json(formatPrice(c.req.valid("json"))),
    );
}

export type AppType = ReturnType<typeof createApp>;
EOF
emit apps/api/src/server.ts <<'EOF'
import { createDb } from "__SCOPE__/db";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadEnv } from "./env.ts";

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const app = createApp({ db });

const server = serve({ fetch: app.fetch, port: env.PORT }, ({ port }) => {
  console.log(`api → http://localhost:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    void db.$client.end({ timeout: 5 }).finally(() => process.exit(0));
  });
}
EOF
emit apps/api/src/app.test.ts <<'EOF'
import type { Db } from "__SCOPE__/db";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";

const downDb = {
  execute: () => Promise.reject(new Error("bağlantı yok")),
} as unknown as Db;

describe("api", () => {
  const app = createApp({ db: downDb });

  it("DB erişilemezse degraded döner", async () => {
    const res = await app.request("/api/health");
    expect(await res.json()).toEqual({ status: "degraded", db: "down" });
  });

  it("fiyatı biçimlendirir", async () => {
    const res = await app.request("/api/format-price", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: "123456", currency: "USD", locale: "en-US" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ formatted: "$1,234.56" });
  });

  it("geçersiz girdiyi contracts şemasıyla reddeder", async () => {
    const res = await app.request("/api/format-price", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: "12.5", currency: "USD" }),
    });
    expect(res.status).toBe(400);
  });
});
EOF

# --- apps/worker -------------------------------------------------------------------
node_app_files apps/worker '{
    "__SCOPE__/core": "workspace:*",
    "__SCOPE__/db": "workspace:*",
    "pg-boss": "catalog:",
    "zod": "catalog:"
  }' worker
mkdir -p apps/worker/src/jobs
emit apps/worker/src/index.ts <<'EOF'
export { jobs } from "./jobs/index.ts";
EOF
emit apps/worker/src/jobs/index.ts <<'EOF'
import { healthcheck } from "./healthcheck.ts";

/** Her iş: kuyruk adı + (opsiyonel) cron + handler. Handler yalnızca core çağırır. */
export const jobs = [healthcheck];
EOF
emit apps/worker/src/jobs/healthcheck.ts <<'EOF'
import { checkHealth } from "__SCOPE__/core";
import type { Db } from "__SCOPE__/db";

export const healthcheck = {
  name: "healthcheck",
  cron: "*/5 * * * *",
  async handle(db: Db): Promise<void> {
    const result = await checkHealth(db);
    console.log("healthcheck", result);
  },
};
EOF
emit apps/worker/src/worker.ts <<'EOF'
import { createDb } from "__SCOPE__/db";
import { PgBoss } from "pg-boss";
import { loadEnv } from "./env.ts";
import { jobs } from "./jobs/index.ts";

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
const boss = new PgBoss(env.DATABASE_URL);
boss.on("error", (error) => console.error("pg-boss", error));

await boss.start();
for (const job of jobs) {
  await boss.createQueue(job.name);
  await boss.work(job.name, async () => job.handle(db));
  if (job.cron) await boss.schedule(job.name, job.cron);
}
console.log(`worker → ${jobs.length} kuyruk dinleniyor`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void boss
      .stop()
      .then(() => db.$client.end({ timeout: 5 }))
      .finally(() => process.exit(0));
  });
}
EOF

# --- apps/web ----------------------------------------------------------------------
mkdir -p apps/web/src/lib
emit apps/web/package.json <<'EOF'
{
  "name": "__SCOPE__/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc -p ."
  },
  "dependencies": {
    "__SCOPE__/contracts": "workspace:*",
    "__SCOPE__/domain": "workspace:*",
    "@tanstack/react-query": "catalog:",
    "hono": "catalog:",
    "react": "catalog:",
    "react-dom": "catalog:"
  },
  "devDependencies": {
    "__SCOPE__/api": "workspace:*",
    "@types/react": "catalog:",
    "@types/react-dom": "catalog:",
    "@vitejs/plugin-react": "catalog:",
    "vite": "catalog:"
  }
}
EOF
emit apps/web/tsconfig.json <<'EOF'
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "lib": ["ES2024", "DOM", "DOM.Iterable"],
    // "node": AppType tipi api kaynağından çıkarıldığı için api'nin Node tiplerine ihtiyaç var.
    "types": ["vite/client", "node"]
  },
  "include": ["src", "vite.config.ts"]
}
EOF
emit apps/web/vite.config.ts <<'EOF'
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:3000" } },
});
EOF
emit apps/web/index.html <<'EOF'
<!doctype html>
<html lang="tr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
EOF
emit apps/web/src/lib/api.ts <<'EOF'
import type { AppType } from "__SCOPE__/api";
import { hc } from "hono/client";

/** API'ye tek erişim noktası. Uç noktalar ve tipler api'deki Hono uygulamasından çıkarılır. */
export const api = hc<AppType>("/").api;
EOF
emit apps/web/src/main.tsx <<'EOF'
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./lib/api.ts";

function Health() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: async () => (await api.health.$get()).json(),
  });
  if (health.isPending) return <p>Yükleniyor…</p>;
  if (health.isError) return <p>API'ye ulaşılamadı.</p>;
  return (
    <p>
      API: {health.data.status} · DB: {health.data.db}
    </p>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("#root bulunamadı");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <h1>Hello</h1>
      <Health />
    </QueryClientProvider>
  </StrictMode>,
);
EOF

# --- Yer tutucuları doldur -------------------------------------------------------------
# Yalnızca bu çalıştırmada oluşturulan dosyalara dokunulur.
if (( ${#WRITTEN[@]} )); then
  SCOPE="$SCOPE" NODE_MAJOR="$NODE_MAJOR" PNPM_VERSION="$PNPM_VERSION" perl -pi -e '
    s/__SCOPE_RE__/$ENV{SCOPE}/g;
    s/__SCOPE__/$ENV{SCOPE}/g;
    s/__NODE_MAJOR__/$ENV{NODE_MAJOR}/g;
    s/__PNPM__/$ENV{PNPM_VERSION}/g;
  ' "${WRITTEN[@]}"
fi

# CLAUDE.md blok özetini architecture.json'a yaz (yalnızca architecture.json yeni oluşturulduysa)
if grep -q '__CLAUDE_SHA__' architecture.json 2>/dev/null; then
  CLAUDE_SHA="$(node scripts/arch-check.mjs --claude-hash)"
  CLAUDE_SHA="$CLAUDE_SHA" perl -pi -e 's/__CLAUDE_SHA__/$ENV{CLAUDE_SHA}/g' architecture.json
fi

# --- Kurulum + doğrulama ---------------------------------------------------------------
git rev-parse --git-dir >/dev/null 2>&1 || git init -q -b main
if (( INSTALL )); then
  echo "→ Bağımlılıklar kuruluyor..."
  pnpm install
  if (( ${#WRITTEN[@]} )); then
    pnpm exec biome check --write --files-ignore-unknown=true --no-errors-on-unmatched \
      "${WRITTEN[@]}" >/dev/null || true
  fi
  echo "→ pnpm verify"
  pnpm verify
fi

cat <<EOF

✓ Scaffold hazır: $(pwd)  (${#WRITTEN[@]} yeni dosya)

Sonraki adımlar:
  cp .env.example .env && docker compose up -d
  pnpm dev                       # api :3000, web :5173, worker
  .github/CODEOWNERS             # mimari dosyalarına sahip atayın
  git add -A && git commit -m "chore: scaffold"
EOF
