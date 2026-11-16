import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyBrowserNetwork,
  chainOf,
  chainTrusted,
  proxyLogin,
  proxySetting,
  readCas,
  verifyAnswer,
  type ProxySetting,
} from "./network";

describe("proxySetting", () => {
  it("no proxy in the settings: the system proxy", () => {
    expect(proxySetting({ caFile: null, useSystemCa: true })).toEqual({
      mode: "system",
    });
  });
  it("a proxy: that one, its exceptions and this machine bypassed, no password in the rules", () => {
    expect(
      proxySetting({
        proxy: {
          url: "http://u:p%40ss@proxy.corp:8080",
          noProxy: ["intranet.corp", ".corp.local", "10.0.0.0/8"],
        },
        caFile: null,
        useSystemCa: true,
      }),
    ).toEqual({
      mode: "fixed_servers",
      proxyRules: "http://proxy.corp:8080",
      proxyBypassRules: "intranet.corp,*.corp.local,10.0.0.0/8,<local>",
    });
  });
  it("without a scheme or port, and socks", () => {
    expect(
      (
        proxySetting({
          proxy: { url: "proxy.corp", noProxy: [] },
          caFile: null,
          useSystemCa: true,
        }) as Extract<ProxySetting, { mode: "fixed_servers" }>
      ).proxyRules,
    ).toBe("http://proxy.corp:80");
    expect(
      (
        proxySetting({
          proxy: { url: "socks5://10.1.1.1", noProxy: [] },
          caFile: null,
          useSystemCa: true,
        }) as Extract<ProxySetting, { mode: "fixed_servers" }>
      ).proxyRules,
    ).toBe("socks5://10.1.1.1:1080");
  });
  it("an address that cannot be read: the system proxy", () => {
    expect(
      proxySetting({
        proxy: { url: "http://[bad", noProxy: [] },
        caFile: null,
        useSystemCa: true,
      }),
    ).toEqual({ mode: "system" });
  });
});

describe("proxyLogin", () => {
  const n = {
    proxy: { url: "http://u%20x:p%40ss@Proxy.Corp:8080", noProxy: [] },
    caFile: null,
    useSystemCa: true,
  };
  it("gives the user name and password only to that proxy", () => {
    expect(proxyLogin(n, { host: "proxy.corp", port: 8080 })).toEqual({
      username: "u x",
      password: "p@ss",
    });
    expect(proxyLogin(n, { host: "evil.example", port: 8080 })).toBeNull();
    expect(proxyLogin(n, { host: "proxy.corp", port: 3128 })).toBeNull();
  });
  it("none without a user name or a proxy", () => {
    expect(
      proxyLogin(
        {
          proxy: { url: "http://proxy.corp:8080", noProxy: [] },
          caFile: null,
          useSystemCa: true,
        },
        { host: "proxy.corp", port: 8080 },
      ),
    ).toBeNull();
    expect(
      proxyLogin(
        { caFile: null, useSystemCa: true },
        { host: "proxy.corp", port: 8080 },
      ),
    ).toBeNull();
  });
});

describe("chainOf", () => {
  it("leaf first, stops at a repeat", () => {
    const root: { data: string; issuerCert?: unknown } = { data: "R" };
    root.issuerCert = root;
    expect(
      chainOf({
        data: "L",
        issuerCert: { data: "I", issuerCert: root as never },
      }),
    ).toEqual(["L", "I", "R"]);
  });
});

/** A throwaway CA, an intermediate it signed, and a server certificate the intermediate signed (needs openssl). */
function makeChain(
  at: string,
): { ca: string; inter: string; leaf: string; other: string } | undefined {
  try {
    const run = (...args: string[]) =>
      execFileSync("openssl", args, {
        cwd: at,
        stdio: "pipe",
        env: { ...process.env, OPENSSL_CONF: join(at, "o.cnf") },
      });
    writeFileSync(
      join(at, "o.cnf"),
      [
        "[req]",
        "distinguished_name=dn",
        "[dn]",
        "[ca_ext]",
        "basicConstraints=critical,CA:TRUE",
        "keyUsage=critical,keyCertSign,cRLSign",
        "[ext]",
        "subjectAltName=DNS:localhost",
        "basicConstraints=CA:FALSE",
        "",
      ].join("\n"),
    );
    run(
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "ca.key",
      "-out",
      "ca.pem",
      "-days",
      "2",
      "-subj",
      "/CN=Test Root",
      "-config",
      "o.cnf",
      "-extensions",
      "ca_ext",
    );
    run(
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "other.key",
      "-out",
      "other.pem",
      "-days",
      "2",
      "-subj",
      "/CN=Test Root",
      "-config",
      "o.cnf",
      "-extensions",
      "ca_ext",
    );
    run(
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "in.key",
      "-out",
      "in.csr",
      "-subj",
      "/CN=Test Intermediate",
      "-config",
      "o.cnf",
    );
    run(
      "x509",
      "-req",
      "-in",
      "in.csr",
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-out",
      "in.pem",
      "-days",
      "2",
      "-extfile",
      "o.cnf",
      "-extensions",
      "ca_ext",
    );
    run(
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "srv.key",
      "-out",
      "srv.csr",
      "-subj",
      "/CN=localhost",
      "-config",
      "o.cnf",
    );
    run(
      "x509",
      "-req",
      "-in",
      "srv.csr",
      "-CA",
      "in.pem",
      "-CAkey",
      "in.key",
      "-CAcreateserial",
      "-out",
      "srv.pem",
      "-days",
      "2",
      "-extfile",
      "o.cnf",
      "-extensions",
      "ext",
    );
    const r = (f: string) => readFileSync(join(at, f), "utf8");
    return {
      ca: r("ca.pem"),
      inter: r("in.pem"),
      leaf: r("srv.pem"),
      other: r("other.pem"),
    };
  } catch {
    return undefined;
  }
}

const dir = mkdtempSync(join(tmpdir(), "spica-browser-net-"));
const chain = makeChain(dir);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!chain)("the extra trusted certificate file", () => {
  const c = chain!;
  const caFile = join(dir, "trusted.pem");
  it("trusts a chain that leads to a certificate in the file", () => {
    writeFileSync(caFile, `junk\n${c.ca}\n`);
    const cas = readCas(caFile);
    expect(cas).toHaveLength(1);
    expect(chainTrusted([c.leaf, c.inter], cas)).toBe(true);
    expect(chainTrusted([c.inter], cas)).toBe(true);
  });
  it("not a chain that skips a link, or leads to another certificate with the same name", () => {
    const cas = readCas(caFile);
    expect(chainTrusted([c.leaf], cas)).toBe(false);
    expect(chainTrusted([c.leaf, c.inter], readCas(null))).toBe(false);
    writeFileSync(join(dir, "other-file.pem"), c.other);
    expect(
      chainTrusted([c.leaf, c.inter], readCas(join(dir, "other-file.pem"))),
    ).toBe(false);
  });
  it("changes only the unknown-authority verdict", () => {
    const cas = readCas(caFile);
    const cert = { data: c.leaf, issuerCert: { data: c.inter } };
    expect(verifyAnswer("net::ERR_CERT_AUTHORITY_INVALID", cert, cas)).toBe(0);
    expect(verifyAnswer("net::ERR_CERT_COMMON_NAME_INVALID", cert, cas)).toBe(
      -3,
    );
    expect(verifyAnswer("net::OK", cert, cas)).toBe(-3);
    expect(
      verifyAnswer("net::ERR_CERT_AUTHORITY_INVALID", { data: c.leaf }, cas),
    ).toBe(-3);
  });
});

it("a file that cannot be read gives no certificates", () => {
  expect(readCas(join(dir, "missing.pem"))).toEqual([]);
});

it("applyBrowserNetwork sets the proxy and the certificate check on the session", async () => {
  const calls: unknown[] = [];
  let proc:
    | ((
        r: { verificationResult: string; certificate: { data: string } },
        cb: (n: number) => void,
      ) => void)
    | undefined;
  await applyBrowserNetwork(
    {
      setProxy: async (p) => void calls.push(p),
      setCertificateVerifyProc: (f) => void (proc = f),
    },
    {
      proxy: { url: "http://proxy.corp:3128", noProxy: [] },
      caFile: null,
      useSystemCa: true,
    },
  );
  expect(calls).toEqual([
    {
      mode: "fixed_servers",
      proxyRules: "http://proxy.corp:3128",
      proxyBypassRules: "<local>",
    },
  ]);
  let code: number | undefined;
  proc!(
    { verificationResult: "net::OK", certificate: { data: "x" } },
    (n) => (code = n),
  );
  expect(code).toBe(-3);
});
