// Throwaway: does PUT /contacts wipe the fields it is not sent?
import { createDecipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^"|"$/g, "")];
    }),
);

const client = new pg.Client({ connectionString: env.DATABASE_URL });
await client.connect();
const { rows } = await client.query(
  `select "secretCiphertext", "secretIv", "secretAuthTag" from "IntegrationSettings" where provider = 'HOLDED'`,
);
await client.end();

const decipher = createDecipheriv(
  "aes-256-gcm",
  Buffer.from(env.BOOKING_SECRET_KEY, "base64"),
  rows[0].secretIv,
);
decipher.setAuthTag(rows[0].secretAuthTag);
const apiKey = Buffer.concat([
  decipher.update(rows[0].secretCiphertext),
  decipher.final(),
]).toString("utf8");

async function call(method, path, body) {
  const response = await fetch(`https://api.holded.com/api/v2${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const created = await call("POST", "/contacts", {
  name: "ZZ Prueba integracion - borrar",
  code: "ZZTEST0001X",
  email: "prueba@example.test",
  phone: "+34930000000",
  mobile: "+34600000000",
  website: "https://example.test",
  type: "client",
  is_person: false,
  bill_address: {
    address: "Carrer de Prova 1",
    city: "Barcelona",
    postal_code: "08001",
    province: "Barcelona",
    country: "Espana",
    country_code: "ES",
  },
});
console.log("create:", created.status, created.body?.id);
const id = created.body?.id;
if (!id) {
  console.log(JSON.stringify(created.body));
  process.exit(1);
}

const before = (await call("GET", `/contacts/${id}`)).body;
console.log(
  "before:",
  JSON.stringify({
    email: before.email,
    phone: before.phone,
    mobile: before.mobile,
    website: before.website,
    address: before.bill_address?.address,
  }),
);

// Send only the email, as a minimal partial update would.
const put = await call("PUT", `/contacts/${id}`, {
  name: before.name,
  email: "nuevo@example.test",
});
console.log("put:", put.status, JSON.stringify(put.body));

const after = (await call("GET", `/contacts/${id}`)).body;
console.log(
  "after :",
  JSON.stringify({
    email: after.email,
    phone: after.phone,
    mobile: after.mobile,
    website: after.website,
    address: after.bill_address?.address,
    code: after.code,
  }),
);

const wiped = ["phone", "mobile", "website", "code"].filter((k) => before[k] && !after[k]);
console.log("\nWIPED BY OMISSION:", wiped.length ? wiped.join(", ") : "nothing");
console.log(
  "address wiped:",
  Boolean(before.bill_address?.address) && !after.bill_address?.address,
);

console.log("delete:", (await call("DELETE", `/contacts/${id}`)).status);
