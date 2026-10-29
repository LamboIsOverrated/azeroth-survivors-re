import test from "node:test";
import assert from "node:assert/strict";
import { worldTransport } from "../soap.mjs";
const command = `realmbridge v1 TEST status ${"a".repeat(64)} grant 1 7 70 50`;
const options = {
  url: "http://realm-core.railway.internal:7878/",
  username: "fixture",
  password: "not-a-real-secret",
};
const envelope = (text) =>
  `<SOAP-ENV:Envelope><SOAP-ENV:Body><ns1:executeCommandResponse><result>${text}</result></ns1:executeCommandResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
test("SOAP transport submits only fixed typed commands and parses one bounded receipt", async () => {
  const transport = worldTransport({
    ...options,
    fetchImpl: async (url, request) => {
      assert.equal(url, options.url);
      assert.equal(request.redirect, "error");
      assert.match(request.body, /<command>realmbridge v1 TEST status/);
      assert.equal(
        request.headers.authorization,
        "Basic Zml4dHVyZTpub3QtYS1yZWFsLXNlY3JldA==",
      );
      return new Response(
        envelope(
          "REALM_BRIDGE_V1 {&quot;id&quot;:&quot;a&quot;,&quot;state&quot;:&quot;absent&quot;}&#xD;\n",
        ),
      );
    },
  });
  assert.deepEqual(await transport.execute(command), {
    id: "a",
    state: "absent",
  });
  await assert.rejects(() => transport.execute("server shutdown 0"));
  await assert.rejects(() =>
    transport.execute(command.replace("TEST", "LIVE")),
  );
});
test("public targets, credentials in URL, SOAP faults, entities and oversized responses fail closed", async () => {
  for (const url of [
    "https://example.com/",
    "http://realm-core.railway.internal:7878/?target=x",
    "http://x:y@localhost:7878/",
  ])
    assert.throws(() => worldTransport({ ...options, url }));
  for (const xml of [
    '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///secret">]>' + envelope("&x;"),
    "<SOAP-ENV:Fault/>",
    envelope("REALM_BRIDGE_V1 {}") + envelope("REALM_BRIDGE_V1 {}"),
    "x".repeat(65537),
  ]) {
    const transport = worldTransport({
      ...options,
      fetchImpl: async () => new Response(xml),
    });
    await assert.rejects(() => transport.execute(command));
  }
});
