const fixtureValue = process.env.E2E_PROVIDER_HTTP_URL;
if (!fixtureValue) {
  throw new Error("E2E_PROVIDER_HTTP_URL is required by the provider fetch preload");
}

const fixtureUrl = new URL(fixtureValue);
if (
  fixtureUrl.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "::1"].includes(fixtureUrl.hostname)
) {
  throw new Error("E2E provider fixture must use a loopback HTTP URL");
}

const fixturePathByLogicalUrl = new Map([
  ["https://api.brevo.com/v3/account", "/provider/brevo/health"],
  ["https://api.brevo.com/v3/smtp/email", "/provider/brevo/send"],
  ["https://api.mailjet.com/v3/REST/sender?Limit=1", "/provider/mailjet/health"],
  ["https://api.mailjet.com/v3.1/send", "/provider/mailjet/send"],
]);
const nativeFetch = globalThis.fetch.bind(globalThis);

function holdedFixturePath(logicalUrl) {
  const url = new URL(logicalUrl);
  if (url.origin !== "https://api.holded.com") return undefined;
  const treasuryAccountsPath = "/api/v2/treasury/accounts";
  const bankMovementsPath = new RegExp(
    `^${treasuryAccountsPath}/[0-9a-f]{24}/bank-movements$`,
    "iu",
  );
  if (
    url.pathname !== treasuryAccountsPath &&
    !bankMovementsPath.test(url.pathname)
  ) {
    return undefined;
  }
  return `/provider/holded${url.pathname}${url.search}`;
}

globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const fixturePath =
    fixturePathByLogicalUrl.get(request.url) ?? holdedFixturePath(request.url);
  if (!fixturePath) return nativeFetch(input, init);

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : Buffer.from(await request.arrayBuffer());

  return nativeFetch(new URL(fixturePath, fixtureUrl), {
    method: request.method,
    headers,
    body,
    redirect: "manual",
    signal: request.signal,
  });
};
