/**
 * The test OpenID Connect provider of the server's unit tests (apps/server/test/helpers/mock-oidc.ts),
 * served over http on 127.0.0.1 for the browser and the e2e server. /authorize signs `provider.user`
 * in at once and sends the browser back to SiteKeep with a code.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { MockOidcProvider } from "../../apps/server/test/helpers/mock-oidc";

export async function startOidcProvider(): Promise<{ provider: MockOidcProvider; close(): Promise<void> }> {
  let provider: MockOidcProvider | null = null;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        try {
          const url = new URL(req.url ?? "/", provider!.issuer);
          if (url.pathname === "/authorize") {
            res.writeHead(302, { location: provider!.authorize(url.toString()) });
            res.end();
            return;
          }
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
          const body = Buffer.concat(chunks);
          const answer = await provider!.handle(url.toString(), { method: req.method, headers, body: body.length ? body.toString() : undefined });
          res.writeHead(answer.status, Object.fromEntries(answer.headers));
          res.end(Buffer.from(await answer.arrayBuffer()));
        } catch (err) {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end(String(err));
        }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  provider = await MockOidcProvider.create({ issuer: `http://127.0.0.1:${port}` });
  return { provider, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
