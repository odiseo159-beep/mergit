// La regla del servidor MCP, comprobada: nada en él puede tocar una clave ni firmar.
// Si un cambio futuro mete algo de esto, este test lo para antes de publicarlo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const PROHIBIDO = [
  /privateKey/i, /secret\.json/i, /MERGIT_AGENT_KEY/, /loadSecrets/, /writeContract/,
  /sendTransaction/, /signMessage/, /signTransaction/, /createWalletClient/, /mnemonic/i,
  /privateKeyToAccount/,
];
const dir = new URL("../", import.meta.url);
const fuentes = readdirSync(dir).filter((f) => f.endsWith(".mjs"));

test("hay fuentes que revisar", () => assert.ok(fuentes.includes("tools.mjs") && fuentes.includes("server.mjs")));

for (const f of fuentes) {
  test(`${f} no toca claves ni firma`, () => {
    const texto = readFileSync(new URL(f, dir), "utf8")
      .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join("\n");   // los comentarios pueden nombrar la regla
    for (const re of PROHIBIDO) assert.doesNotMatch(texto, re, `${f} menciona ${re}`);
  });
}

test("tools.mjs no importa nada del agente que firme", () => {
  const texto = readFileSync(new URL("tools.mjs", dir), "utf8");
  const desde = [...texto.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  for (const m of desde.filter((x) => x.startsWith("../agent/"))) {
    assert.match(m, /^\.\.\/agent\/(bounties|verify|registry|chain)\.mjs$/, `tools.mjs importa ${m}`);
  }
});
