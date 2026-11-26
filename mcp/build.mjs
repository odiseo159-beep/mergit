// Empaqueta el servidor en un solo archivo para npm: server.mjs, tools.mjs, el
// código de agent/ que importa, viem, el SDK de MCP y zod. Así quien lo instala
// corre `npx -y mergit-mcp` sin clonar el repo.
//
//   npm run build      → dist/mergit-mcp.mjs
//
// Lo corre `prepublishOnly`, después de los tests: no se publica nada que no
// se haya construido y probado en ese momento.
import { build } from "esbuild";
import { readFileSync, rmSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
rmSync(new URL("./dist", import.meta.url), { recursive: true, force: true });

// agent/verify.mjs también es un comando: corre su CLI si `import.meta.url` es el
// archivo lanzado. En un solo archivo, todos los módulos comparten esa URL, y el
// servidor se cerraba imprimiendo "uso: node verify.mjs". Se apaga ese bloque al
// empaquetar, sin tocar agent/. Si la guardia cambia de forma, el build falla en
// vez de publicar un paquete que se cierra solo.
const GUARDIA = "process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href";
const sinCli = {
  name: "sin-cli-del-agente",
  setup(b) {
    b.onLoad({ filter: /[\\/]agent[\\/]verify\.mjs$/ }, (args) => {
      const texto = readFileSync(args.path, "utf8");
      if (!texto.includes(GUARDIA)) throw new Error("agent/verify.mjs cambió su guardia de CLI: revisa build.mjs");
      return { contents: texto.replace(GUARDIA, "false"), loader: "js" };
    });
  },
};

await build({
  plugins: [sinCli],
  entryPoints: [new URL("./server.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")],
  outfile: new URL("./dist/mergit-mcp.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: false,          // legible a propósito: quien lo instala puede leer qué corre
  legalComments: "inline",
  define: { __MERGIT_MCP_VERSION__: JSON.stringify(version) },
  // Algunas dependencias usan require() dentro de ESM; esto se lo da.
  // Sin "#!": esbuild ya conserva el de server.mjs, y dos seguidos rompen el archivo.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
console.error(`dist/mergit-mcp.mjs (v${version})`);
