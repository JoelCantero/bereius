// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    BRAND: {
      canonicalOrigin: "https://app.example.test",
    },
  }),
}));

import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import {
  localizedAlternates,
  localizedPath,
  noIndexMetadata,
  publicPageMetadata,
} from "@/lib/seo";

describe("localized SEO metadata", () => {
  it("builds locale-aware paths without prefixing the default locale", () => {
    expect(localizedPath("en", "/privacy")).toBe("/privacy");
    expect(localizedPath("es", "/privacy")).toBe("/es/privacy");
    expect(localizedPath("ca", "/")).toBe("/ca");
  });

  it("builds reciprocal hreflang URLs with an English default", () => {
    expect(localizedAlternates("https://app.example.test", "/terms")).toEqual({
      languages: {
        en: "https://app.example.test/terms",
        es: "https://app.example.test/es/terms",
        ca: "https://app.example.test/ca/terms",
        "x-default": "https://app.example.test/terms",
      },
    });
  });

  it("uses the localized canonical URL in Open Graph metadata", () => {
    const metadata = publicPageMetadata({
      origin: "https://app.example.test",
      siteName: "Example app",
      locale: "es",
      pathname: "/privacy",
      title: "Privacidad",
      description: "Aviso de privacidad",
    });

    expect(metadata.alternates?.canonical).toBe(
      "https://app.example.test/es/privacy",
    );
    expect(metadata.openGraph).toEqual(
      expect.objectContaining({
        url: "https://app.example.test/es/privacy",
        locale: "es_ES",
        alternateLocale: ["en_US", "ca_ES"],
      }),
    );
  });

  it("marks non-indexable pages without discarding their metadata", () => {
    expect(noIndexMetadata({ title: "Privacy" })).toEqual({
      title: "Privacy",
      robots: { index: false, follow: false },
    });
  });

  it("publishes only canonical public pages in the sitemap", () => {
    const entries = sitemap();

    expect(entries).toHaveLength(3);
    expect(entries).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: expect.stringContaining("/account") }),
        expect.objectContaining({ url: expect.stringContaining("/privacy") }),
        expect.objectContaining({ url: expect.stringContaining("/terms") }),
      ]),
    );
    expect(entries[0]?.alternates?.languages).toEqual(
      expect.objectContaining({
        en: "https://app.example.test/",
        es: "https://app.example.test/es",
        ca: "https://app.example.test/ca",
      }),
    );
  });

  it("excludes every localized bank-movements URL from sitemap locations and alternates", () => {
    const serializedEntries = JSON.stringify(sitemap());

    for (const privatePath of [
      "/bank-movements",
      "/es/bank-movements",
      "/ca/bank-movements",
    ]) {
      expect(serializedEntries).not.toContain(privatePath);
    }
  });

  it("allows HTML pages to expose noindex and blocks API crawling", () => {
    expect(robots()).toEqual({
      rules: {
        userAgent: "*",
        allow: "/",
        disallow: "/api",
      },
      sitemap: "https://app.example.test/sitemap.xml",
      host: "https://app.example.test",
    });
    expect(robots().rules).toMatchObject({ allow: "/", disallow: "/api" });
  });
});