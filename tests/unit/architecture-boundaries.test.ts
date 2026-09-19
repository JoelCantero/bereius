// @vitest-environment node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const HEALTH_ROUTE = "src/app/api/health/route.ts";

type BoundaryRule = "A" | "B" | "C" | "D";

interface BoundaryViolation {
  readonly rule: BoundaryRule;
  readonly path: string;
  readonly detail: string;
}

interface SourceFile {
  readonly path: string;
  readonly source: string;
}

function toWorkspacePath(absolutePath: string) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function moduleSpecifiers(source: string) {
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/gu,
    /\bimport\s+["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']/gu,
  ];
  const specifiers = new Set<string>();
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers];
}

function isPersistenceModule(specifier: string) {
  return (
    specifier === "@/lib/db" ||
    specifier.startsWith("@/lib/db/") ||
    specifier === "@/generated/prisma" ||
    specifier.startsWith("@/generated/prisma/")
  );
}

function isDomainServiceModule(specifier: string) {
  return /(?:^|\/)service$/u.test(specifier) || /(?:^|\/)services\//u.test(specifier);
}

function isApiRoute(relativePath: string) {
  return /^src\/app\/api\/(?:.+\/)?route\.ts$/u.test(relativePath);
}

function isDomainService(relativePath: string) {
  return (
    /^src\/modules\/.+\/service\.ts$/u.test(relativePath) ||
    /^src\/modules\/.+\/services\/.+\.tsx?$/u.test(relativePath)
  );
}

function isPublicModuleTypes(relativePath: string) {
  return /^src\/modules\/.+\/types\.ts$/u.test(relativePath);
}

function isBankingClientPath(relativePath: string) {
  return /^src\/modules\/banking\/components\/.+\.tsx?$/u.test(relativePath);
}

function isBankingPrivateServerModule(specifier: string) {
  return (
    specifier === "@/lib/env" ||
    specifier.startsWith("@/lib/booking/secrets") ||
    specifier.startsWith("@/lib/holded/") ||
    (/^@\/modules\/banking\//u.test(specifier) &&
      !specifier.startsWith("@/modules/banking/components/") &&
      specifier !== "@/modules/banking/schema" &&
      specifier !== "@/modules/banking/types")
  );
}

// A client module is identified by its directive prologue, not by a filename convention.
function isClientModule(source: string) {
  let rest = source.replace(/^\uFEFF/u, "");
  for (;;) {
    const trimmed = rest.replace(/^\s+/u, "");
    if (trimmed.startsWith("//")) {
      const lineEnd = trimmed.indexOf("\n");
      if (lineEnd === -1) return false;
      rest = trimmed.slice(lineEnd + 1);
      continue;
    }
    if (trimmed.startsWith("/*")) {
      const commentEnd = trimmed.indexOf("*/");
      if (commentEnd === -1) return false;
      rest = trimmed.slice(commentEnd + 2);
      continue;
    }
    const directive = /^(["'])([^"']*)\1[^\S\n]*;?/u.exec(trimmed);
    if (!directive) return false;
    if (directive[2] === "use client") return true;
    rest = trimmed.slice(directive[0].length);
  }
}

function hasEnableBankingReference(source: string) {
  return /enable(?:[\s_-]*banking|banking)/iu.test(source);
}

function transportConstructions(source: string) {
  const patterns: readonly [string, RegExp][] = [
    ["new Response", /\bnew\s+Response\s*\(/u],
    ["Response.json", /\bResponse\s*\.\s*json\s*\(/u],
    ["Response.redirect", /\bResponse\s*\.\s*redirect\s*\(/u],
    ["NextResponse", /\bNextResponse\b/u],
  ];
  return patterns.filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
}

function findViolations(file: SourceFile): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const specifiers = moduleSpecifiers(file.source);

  if (isApiRoute(file.path) && file.path !== HEALTH_ROUTE) {
    for (const specifier of specifiers.filter(isPersistenceModule)) {
      violations.push({
        rule: "A",
        path: file.path,
        detail: `route imports persistence module ${specifier}`,
      });
    }
  }

  if (isDomainService(file.path)) {
    for (const construction of transportConstructions(file.source)) {
      violations.push({
        rule: "B",
        path: file.path,
        detail: `service constructs transport response ${construction}`,
      });
    }
  }

  if (isPublicModuleTypes(file.path)) {
    for (const specifier of specifiers.filter(isPersistenceModule)) {
      violations.push({
        rule: "C",
        path: file.path,
        detail: `public types import persistence module ${specifier}`,
      });
    }
  }

  if (isClientModule(file.source)) {
    for (const specifier of specifiers) {
      if (
        isPersistenceModule(specifier) ||
        isDomainServiceModule(specifier) ||
        specifier === "server-only" ||
        (isBankingClientPath(file.path) && isBankingPrivateServerModule(specifier))
      ) {
        violations.push({
          rule: "D",
          path: file.path,
          detail: `client module imports server module ${specifier}`,
        });
      }
    }
  }

  return violations;
}

function formatViolations(violations: readonly BoundaryViolation[]) {
  return violations.map(
    (violation) => `Rule ${violation.rule}: ${violation.path} — ${violation.detail}`,
  );
}

async function sourceFilesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        // Generated persistence contracts are infrastructure, not application layers.
        return entry.name === "generated" ? [] : sourceFilesUnder(entryPath);
      }
      return /\.tsx?$/u.test(entry.name) ? [entryPath] : [];
    }),
  );
  return nested.flat();
}

async function readApplicationSources(): Promise<SourceFile[]> {
  const files = await sourceFilesUnder(path.join(root, "src"));
  return await Promise.all(
    files.map(async (file) => ({
      path: toWorkspacePath(file),
      source: await readFile(file, "utf8"),
    })),
  );
}

const fixtures: readonly {
  readonly name: string;
  readonly file: SourceFile;
  readonly expected: readonly BoundaryRule[];
}[] = [
  {
    name: "rejects a product route that reads persistence directly",
    file: {
      path: "src/app/api/signup/activate/route.ts",
      source: `import { db } from "@/lib/db";\nexport async function GET() {\n  await db.user.findFirst();\n  return Response.json({ status: "ok" });\n}\n`,
    },
    expected: ["A"],
  },
  {
    name: "rejects a product route that imports generated persistence contracts",
    file: {
      path: "src/app/api/account/deletion/verify/route.ts",
      source: `import { UserStatus } from "@/generated/prisma/client";\nexport const status = UserStatus.ACTIVE;\n`,
    },
    expected: ["A"],
  },
  {
    name: "allows the infrastructure health route to read persistence",
    file: {
      path: HEALTH_ROUTE,
      source: `import { db } from "@/lib/db";\nexport async function GET() {\n  await db.$queryRaw\`SELECT 1\`;\n  return Response.json({ status: "ok" });\n}\n`,
    },
    expected: [],
  },
  {
    name: "rejects a domain service that constructs a response",
    file: {
      path: "src/modules/login/service.ts",
      source: `import "server-only";\nexport async function accepted() {\n  return Response.json({ status: "accepted" });\n}\n`,
    },
    expected: ["B"],
  },
  {
    name: "rejects a nested domain service that constructs a Next response",
    file: {
      path: "src/modules/account/services/export.ts",
      source: `import { NextResponse } from "next/server";\nexport function build() {\n  return NextResponse.next();\n}\n`,
    },
    expected: ["B"],
  },
  {
    name: "allows a domain service that returns a domain result",
    file: {
      path: "src/modules/signup/service.ts",
      source: `import "server-only";\nimport { db } from "@/lib/db";\nexport async function preflight() {\n  await db.verificationToken.findUnique({ where: { token: "hash" } });\n  return { status: "eligible" } as const;\n}\n`,
    },
    expected: [],
  },
  {
    name: "rejects public module types that depend on persistence",
    file: {
      path: "src/modules/account/data-export/types.ts",
      source: `import type { Prisma } from "@/generated/prisma/client";\nexport type Context = { transaction: Prisma.TransactionClient };\n`,
    },
    expected: ["C"],
  },
  {
    name: "allows a server-only internal type module to depend on persistence",
    file: {
      path: "src/modules/account/data-export/internal-types.ts",
      source: `import "server-only";\nimport type { Prisma } from "@/generated/prisma/client";\nexport type Context = { transaction: Prisma.TransactionClient };\n`,
    },
    expected: [],
  },
  {
    name: "rejects a client module that imports a domain service",
    file: {
      path: "src/modules/account/data-export/components/data-export-panel.tsx",
      source: `"use client";\n\nimport { requestExport } from "@/modules/account/data-export/service";\nexport function Panel() {\n  return requestExport;\n}\n`,
    },
    expected: ["D"],
  },
  {
    name: "rejects a client module that imports persistence behind a leading comment",
    file: {
      path: "src/components/account/session-list.tsx",
      source: `// Client island rendered by the account page.\n"use client";\n\nimport { db } from "@/lib/db";\nexport const client = db;\n`,
    },
    expected: ["D"],
  },
  {
    name: "allows a client module that imports public serializable types",
    file: {
      path: "src/modules/account/data-export/components/panel.tsx",
      source: `"use client";\n\nimport type { PersonalDataExportCommand } from "@/modules/account/data-export/types";\nexport function Panel(props: { command: PersonalDataExportCommand }) {\n  return props.command;\n}\n`,
    },
    expected: [],
  },
  {
    name: "rejects a banking client that imports runtime credentials",
    file: {
      path: "src/modules/banking/components/private-panel.tsx",
      source: `"use client";\n\nimport { getEnv } from "@/lib/env";\nexport const secret = getEnv;\n`,
    },
    expected: ["D"],
  },
  {
    name: "rejects a banking client that imports secret storage",
    file: {
      path: "src/modules/banking/components/private-panel.tsx",
      source: `"use client";\n\nimport { openSecret } from "@/lib/booking/secrets";\nexport const secret = openSecret;\n`,
    },
    expected: ["D"],
  },
  {
    name: "rejects a banking client that imports the provider client",
    file: {
      path: "src/modules/banking/components/private-panel.tsx",
      source: `"use client";\n\nimport { createHoldedClient } from "@/lib/holded/client";\nexport const provider = createHoldedClient;\n`,
    },
    expected: ["D"],
  },
  {
    name: "rejects a banking client that imports a server action module",
    file: {
      path: "src/modules/banking/components/private-panel.tsx",
      source: `"use client";\n\nimport type { BankSyncActionState } from "@/modules/banking/actions/synchronization";\nexport type State = BankSyncActionState;\n`,
    },
    expected: ["D"],
  },
  {
    name: "allows a banking client to import its public contracts",
    file: {
      path: "src/modules/banking/components/public-panel.tsx",
      source: `"use client";\n\nimport type { BankSyncActionState } from "@/modules/banking/types";\nexport type State = BankSyncActionState;\n`,
    },
    expected: [],
  },
  {
    name: "allows a Server Component to call a domain service",
    file: {
      path: "src/app/[locale]/account/data/page.tsx",
      source: `import { getPersonalDataExportAuthorization } from "@/modules/account/data-export/service";\nexport default async function Page() {\n  return await getPersonalDataExportAuthorization();\n}\n`,
    },
    expected: [],
  },
];

describe("application boundary rules", () => {
  it.each(fixtures)("$name", ({ file, expected }) => {
    const violations = findViolations(file);

    expect(violations.map((violation) => violation.rule)).toEqual(expected);
    for (const message of formatViolations(violations)) {
      expect(message).toContain(file.path);
    }
  });

  it("keeps the persistence exception limited to the health route", async () => {
    const sources = await readApplicationSources();
    const routes = sources.filter((file) => isApiRoute(file.path));
    const persistenceRoutes = routes
      .filter((file) => moduleSpecifiers(file.source).some(isPersistenceModule))
      .map((file) => file.path);

    expect(routes.length).toBeGreaterThan(1);
    expect(persistenceRoutes).toEqual([HEALTH_ROUTE]);
  });

  it("classifies every scanned application layer at least once", async () => {
    const sources = await readApplicationSources();

    expect(sources.filter((file) => isApiRoute(file.path)).length).toBeGreaterThan(0);
    expect(sources.filter((file) => isDomainService(file.path)).length).toBeGreaterThan(0);
    expect(sources.filter((file) => isPublicModuleTypes(file.path)).length).toBeGreaterThan(0);
    expect(sources.filter((file) => isClientModule(file.source)).length).toBeGreaterThan(0);
  });

  it("reports no boundary violation in the application source tree", async () => {
    const sources = await readApplicationSources();
    const violations = sources.flatMap((file) => findViolations(file));

    expect(formatViolations(violations)).toEqual([]);
  });

  it("recognizes legacy banking source and configuration identifiers", () => {
    expect(
      ["Enable Banking", "enable-banking", "enable_banking", "ENABLEBANKING"].map(
        hasEnableBankingReference,
      ),
    ).toEqual([true, true, true, true]);
    expect(hasEnableBankingReference("Holded bank movements")).toBe(false);
  });

  it("keeps Enable Banking out of runtime and deployable configuration", async () => {
    const applicationSources = await readApplicationSources();
    const deployableFiles = [
      "package.json",
      "pnpm-lock.yaml",
      "next.config.ts",
      "prisma.config.ts",
      "prisma/schema.prisma",
      "docker-compose.yml",
      "docker-compose.e2e.yml",
      "docker-compose.prod.yml",
      "docker/Dockerfile",
    ];
    const deployableSources = await Promise.all(
      deployableFiles.map(async (relativePath) => ({
        path: relativePath,
        source: await readFile(path.join(root, relativePath), "utf8"),
      })),
    );
    const references = [...applicationSources, ...deployableSources]
      .filter((file) => hasEnableBankingReference(file.source))
      .map((file) => file.path);

    expect(references).toEqual([]);
  });
});
