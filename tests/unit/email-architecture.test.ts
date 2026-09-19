// @vitest-environment node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(entryPath) : [entryPath];
    }),
  );
  return nested.flat();
}

describe("transactional email architecture", () => {
  it("locks traceable React Email runtime packages without a CLI or preview server", async () => {
    const packageManifest = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8"),
    ) as {
      packageManager?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const lockfile = await readFile(path.join(root, "pnpm-lock.yaml"), "utf8");
    const importer = lockfile.slice(
      lockfile.indexOf("importers:"),
      lockfile.indexOf("packages:"),
    );
    const renderSource = await readFile(
      path.join(root, "src/lib/email/presentation/render.tsx"),
      "utf8",
    );
    const componentSource = await readFile(
      path.join(
        root,
        "src/lib/email/presentation/components/email-document.tsx",
      ),
      "utf8",
    );
    const nextConfig = await readFile(path.join(root, "next.config.ts"), "utf8");

    expect(packageManifest.packageManager).toBe("pnpm@11.22.0");
    expect(packageManifest.dependencies).toMatchObject({
      "@react-email/components": "1.0.12",
      "@react-email/render": "2.1.0",
    });
    for (const packageName of [
      "react-email",
      "@react-email/preview-server",
    ]) {
      expect(packageManifest.dependencies).not.toHaveProperty(packageName);
      expect(packageManifest.devDependencies).not.toHaveProperty(packageName);
    }
    expect(importer).toMatch(
      /'@react-email\/components':\n\s+specifier: 1\.0\.12\n\s+version: 1\.0\.12/u,
    );
    expect(importer).toMatch(
      /'@react-email\/render':\n\s+specifier: 2\.1\.0\n\s+version: 2\.1\.0/u,
    );
    expect(lockfile).not.toMatch(
      /^  (?:react-email|'@react-email\/preview-server)@/mu,
    );
    expect(renderSource).toMatch(
      /import\s+\{\s*render\s*\}\s+from\s+["']@react-email\/render["']/u,
    );
    expect(componentSource).toMatch(
      /from\s+["']@react-email\/components["']/u,
    );
    expect(nextConfig).toMatch(/output:\s*["']standalone["']/u);
    expect(nextConfig).not.toMatch(
      /serverExternalPackages:\s*\[[\s\S]*?react-email/u,
    );
  });

  it("keeps the preview project out of application imports and the runner image", async () => {
    const sourceFiles = (await filesUnder(path.join(root, "src"))).filter(
      (file) => /\.(?:ts|tsx)$/u.test(file),
    );
    const applicationSource = (
      await Promise.all(sourceFiles.map((file) => readFile(file, "utf8")))
    ).join("\n");
    const dockerfile = await readFile(
      path.join(root, "docker/Dockerfile"),
      "utf8",
    );
    const runnerStage = dockerfile.slice(
      dockerfile.indexOf("FROM base AS runner"),
    );

    expect(applicationSource).not.toMatch(
      /(?:from\s+|import\s*\()["'][^"']*emails(?:\/|["'])/u,
    );
    expect(runnerStage).toContain(
      "COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./",
    );
    expect(runnerStage).toContain(
      "COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static",
    );
    expect(runnerStage).toContain('CMD ["node", "server.js"]');
    expect(runnerStage).not.toMatch(
      /(?:\/app\/emails|email:dev|next\s+dev|react-email)/iu,
    );
    expect(
      [...runnerStage.matchAll(/^COPY\s+.+$/gmu)].map((match) => match[0]),
    ).toEqual([
      "COPY --from=builder /app/public ./public",
      "COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./",
      "COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static",
    ]);
  });

  it("keeps application UI primitives out of transactional email markup", async () => {
    const presentationFiles = (
      await filesUnder(path.join(root, "src/lib/email/presentation"))
    ).filter((file) => /\.(?:ts|tsx)$/u.test(file));
    const presentationSource = (
      await Promise.all(presentationFiles.map((file) => readFile(file, "utf8")))
    ).join("\n");

    expect(presentationSource).not.toMatch(/@\/components\/ui/u);
    expect(presentationSource).not.toMatch(
      /<(?:Checkbox|Alert|Badge|Separator|Spinner|Tooltip|Empty|Tabs|Sidebar)\b/u,
    );
  });

  it("keeps future variants inside presentation with no production trigger or sender", async () => {
    const futureTemplates = [
      "personal-data-export-ready.tsx",
      "account-deleted.tsx",
      "email-change-requested.tsx",
      "email-changed.tsx",
      "security-alert.tsx",
      "generic-confirmation.tsx",
    ];
    const templateFiles = await filesUnder(
      path.join(root, "src/lib/email/presentation/templates"),
    );
    expect(templateFiles.map((file) => path.basename(file))).toEqual(
      expect.arrayContaining(futureTemplates),
    );

    const futureIdentifiers = [
      "personalDataExportReady",
      "accountDeleted",
      "emailChangeRequested",
      "emailChanged",
      "securityAlert",
      "genericConfirmation",
    ];
    const productionFiles = (
      await filesUnder(path.join(root, "src"))
    ).filter(
      (file) =>
        /\.(?:ts|tsx)$/u.test(file) &&
        !file.includes(`${path.sep}lib${path.sep}email${path.sep}presentation${path.sep}`),
    );
    for (const file of productionFiles) {
      const source = await readFile(file, "utf8");
      for (const identifier of futureIdentifiers) {
        expect(source, path.relative(root, file)).not.toContain(
          `"${identifier}"`,
        );
      }
    }

    const deliveryBoundary = await readFile(
      path.join(root, "src/lib/email/index.ts"),
      "utf8",
    );
    expect(deliveryBoundary).not.toMatch(
      /renderEmailPresentation|presentation\/|EmailVariant/u,
    );
  });

  it("exposes no provider webhook route or administrative delivery view", async () => {
    const appFiles = await filesUnder(path.join(root, "src/app"));
    const relativePaths = appFiles.map((file) => path.relative(root, file));

    expect(relativePaths.filter((file) => /webhook/i.test(file))).toEqual([]);
    expect(
      relativePaths.filter(
        (file) => /admin/i.test(file) && /deliver|email-status|message-status/i.test(file),
      ),
    ).toEqual([]);
  });

  it("adds no provider-delivery product model or status field", async () => {
    const schema = await readFile(path.join(root, "prisma/schema.prisma"), "utf8");

    expect(schema).not.toMatch(/model\s+(?:EmailDelivery|DeliveryEvent|ProviderMessage)\b/);
    expect(schema).not.toMatch(
      /^\s*(?:deliveryStatus|providerMessageId|bounceReason|complaintAt)\s+/m,
    );
  });

  it("keeps provider endpoints fixed in source code", async () => {
    const sourceFiles = (await filesUnder(path.join(root, "src"))).filter((file) =>
      /\.(?:ts|tsx)$/.test(file),
    );
    const source = (
      await Promise.all(sourceFiles.map((file) => readFile(file, "utf8")))
    ).join("\n");

    expect(source).not.toMatch(
      /(?:MAIL|BREVO|MAILJET|PROVIDER)_(?:API_)?(?:URL|ENDPOINT)|process\.env\.(?:BREVO|MAILJET).*URL/,
    );
  });

  it("keeps the local preview presentation-only and mutation-free", async () => {
    const previewRoot = path.join(root, "emails");
    const previewFiles = await filesUnder(previewRoot);
    const sourceFiles = previewFiles.filter((file) => /\.(?:ts|tsx)$/u.test(file));
    const relativePaths = sourceFiles.map((file) => path.relative(previewRoot, file));
    const allowedEnvironmentReads = new Map<string, readonly string[]>([
      [
        "next.config.ts",
        [
          "BRAND_COLOR",
          "MAIL_LOGO_URL",
          "PROJECT_NAME",
          "SUPPORT_EMAIL",
        ],
      ],
      [
        "lib/preview-fixtures.ts",
        [
          "EMAIL_PREVIEW_BRAND_COLOR",
          "EMAIL_PREVIEW_LOGO_URL",
          "EMAIL_PREVIEW_SUPPORT_EMAIL",
          "PROJECT_NAME",
        ],
      ],
    ]);

    expect(relativePaths).not.toEqual([]);
    expect(
      relativePaths.filter(
        (file) =>
          /(?:^|\/)api(?:\/|$)/u.test(file) || /(?:^|\/)route\.tsx?$/u.test(file),
      ),
    ).toEqual([]);

    for (const file of sourceFiles) {
      const source = await readFile(file, "utf8");
      const relativePath = path.relative(previewRoot, file);
      const applicationImports = [
        ...source.matchAll(
          /(?:from\s+|import\s*\()\s*["']([^"']*(?:src\/|@\/)[^"']*)["']/gu,
        ),
      ].map((match) => match[1]);

      for (const specifier of applicationImports) {
        expect(specifier, path.relative(root, file)).toMatch(
          /(?:^@\/lib\/email\/presentation(?:\/|$)|src\/lib\/email\/presentation(?:\/|$))/u,
        );
      }
      const environmentReads = [
        ...source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/gu),
      ]
        .map((match) => match[1])
        .sort();
      expect(environmentReads, path.relative(root, file)).toEqual(
        [...(allowedEnvironmentReads.get(relativePath) ?? [])].sort(),
      );
      expect(
        source.replaceAll(/process\.env\.[A-Z][A-Z0-9_]*/gu, ""),
        path.relative(root, file),
      ).not.toContain("process.env");
      expect(source, path.relative(root, file)).not.toMatch(
        /@\/lib\/(?:env|db|auth|logger|email\/index)|@prisma|next-auth|["']use server["']/u,
      );
      expect(source, path.relative(root, file)).not.toMatch(
        /\b(?:sendTransactionalEmail|createTransactionalEmailProvider|getEnv|logger|recipient|upload)\b|<form\b|<input\b|type=["']file["']/iu,
      );
    }
  });
});
