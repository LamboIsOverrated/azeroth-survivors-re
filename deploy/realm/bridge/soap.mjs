const typed =
  /^realmbridge v1 TEST (?:apply|status) [a-f0-9]{64} (?:grant|debit) [1-9][0-9]{0,9} [1-9][0-9]{0,9} [1-9][0-9]{0,9} (?:0|[1-9][0-9]{0,9})$/;
function decode(text) {
  return text.replace(
    /&(?:amp|lt|gt|quot|apos|#(?:[0-9]+|x[0-9a-fA-F]+));/g,
    (entity) => {
      const named = {
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&apos;": "'",
      };
      if (entity in named) return named[entity];
      const value = entity.startsWith("&#x")
        ? parseInt(entity.slice(3, -1), 16)
        : Number(entity.slice(2, -1));
      if (
        !Number.isInteger(value) ||
        value > 0x10ffff ||
        (value >= 0xd800 && value <= 0xdfff) ||
        (value < 32 && ![9, 10, 13].includes(value))
      )
        throw new Error("Invalid SOAP character");
      return String.fromCodePoint(value);
    },
  );
}
export function worldTransport({
  url,
  username,
  password,
  fetchImpl = globalThis.fetch,
}) {
  const endpoint = new URL(url);
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    !(
      ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
      endpoint.hostname.endsWith(".railway.internal")
    ) ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password ||
    typeof username !== "string" ||
    !username ||
    username.includes(":") ||
    typeof password !== "string" ||
    !password
  )
    throw new Error("Fixed private SOAP endpoint and credentials required");
  return {
    async execute(command) {
      if (typeof command !== "string" || !typed.test(command))
        throw new Error("Only typed TEST world-bridge commands are permitted");
      const response = await fetchImpl(endpoint.href, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "text/xml; charset=utf-8",
          SOAPAction: "urn:MaNGOS#executeCommand",
          authorization:
            "Basic " +
            Buffer.from(username + ":" + password).toString("base64"),
        },
        body: `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="urn:MaNGOS"><SOAP-ENV:Body><ns1:executeCommand><command>${command}</command></ns1:executeCommand></SOAP-ENV:Body></SOAP-ENV:Envelope>`,
        signal: AbortSignal.timeout(15000),
      });
      if (
        !response.ok ||
        Number(response.headers.get("content-length") ?? 0) > 65536 ||
        !response.body
      )
        throw new Error("World operation result is indeterminate");
      const reader = response.body.getReader(),
        chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65536) {
          await reader.cancel();
          throw new Error("World operation response exceeds limit");
        }
        chunks.push(value);
      }
      const xml = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks),
      );
      if (/<!DOCTYPE|<!ENTITY|<(?:[A-Za-z0-9_-]+:)?Fault\b/i.test(xml))
        throw new Error("World operation result is indeterminate");
      const matches = [
        ...xml.matchAll(
          /<(?:[A-Za-z0-9_-]+:)?result(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?result>/g,
        ),
      ];
      if (matches.length !== 1)
        throw new Error("Missing unambiguous world receipt");
      const output = decode(matches[0][1]).trim(),
        prefix = "REALM_BRIDGE_V1 ";
      if (
        !output.startsWith(prefix) ||
        output.includes("&") ||
        output.includes("<")
      )
        throw new Error("Invalid world receipt encoding");
      const result = JSON.parse(output.slice(prefix.length));
      if (!result || Array.isArray(result) || typeof result !== "object")
        throw new Error("Invalid world receipt");
      return result;
    },
  };
}
