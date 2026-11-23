# -*- coding: utf-8 -*-
"""Arma site/llms.txt: toda la documentación de Mergit en un archivo.

    python scripts/build-llms.py

Por qué existe. Un agente de codificación que se topa con Mergit no va a recorrer
seis páginas HTML: lee un archivo o no lee nada. README.md explica el protocolo y
AGENTS.md explica cómo usarlo sin tocar una clave; los dos ya estaban escritos, así
que esto no inventa documentación, la sirve junta.

La fuente de verdad siguen siendo los archivos de abajo. Este script no edita nada:
si algo está mal, se arregla en el original y se vuelve a correr.
"""
import io
import os
import re
import sys

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SALIDA = os.path.join(RAIZ, "site", "llms.txt")

# Las direcciones viven en un solo sitio dentro del repo. Si cambian ahí y no aquí,
# el script se detiene en vez de publicar una dirección vieja.
REGISTRY_JSON = os.path.join(RAIZ, "contracts", "registry.json")

CABECERA = """# Mergit

> Bounties for developers on GIWA Chain. A funder locks a reward on chain before any
> work starts. When the work is accepted into the project and its automatic tests
> pass, an agent releases the payment. No committee, no invoice, no waiting.

The protocol and the guide for coding agents, in one file, for anyone who would
rather read than click. The technical one-pager is separate and lives at
https://www.mergit.xyz/docs: contract design, the trust model, and where this
sits next to ERC-8004. Source at https://github.com/odiseo159-beep/mergit

Generated from README.md and AGENTS.md in that repository. Do not edit by hand.

## Where things are

| | |
|---|---|
| Site | https://www.mergit.xyz |
| Start here | https://www.mergit.xyz/start |
| Fund a bounty | https://www.mergit.xyz/post |
| Register a GitHub login on chain | https://www.mergit.xyz/register |
| A builder's record | https://www.mergit.xyz/p/<github-login> |
| Badge for a README | https://www.mergit.xyz/badge/<github-login>.svg |
| Card for a README | https://www.mergit.xyz/card/<github-login>.svg |
| Machine-readable API | https://www.mergit.xyz/openapi.json |
| Source | https://github.com/odiseo159-beep/mergit |
| Reusable GitHub Action | odiseo159-beep/mergit@v1.5 |

## Chain

GIWA Sepolia, chain id 91342. RPC https://sepolia-rpc.giwa.io
Explorer https://sepolia-explorer.giwa.io

This is a test network. The ETH is practice money. The record is not.

{DIRECCIONES}
"""


def direcciones():
    """Saca la dirección del registro de su archivo, y comprueba las de los escrows."""
    import json
    with io.open(REGISTRY_JSON, encoding="utf-8") as f:
        reg = json.load(f)
    registro = reg.get("address") or reg.get("registry") or ""
    if not re.match(r"^0x[0-9a-fA-F]{40}$", registro):
        sys.exit("contracts/registry.json no tiene una direccion usable: %r" % registro)

    filas = [
        ("Escrow v1", "0xffcf206ce1474263aaa3336fb9c8bc3d632e5879",
         "the one with the payment history, and the default"),
        ("Escrow v2", "0x48d506080abdbed11f1acbe40f799301d9612ad5",
         "adds an opt-in challenge window per bounty; zero seconds behaves like v1"),
        ("Identity registry", registro.lower(),
         "one wallet, one GitHub login, one public proof"),
    ]
    out = ["## Contracts", "", "All three deployed and verified on GIWA Sepolia.", "",
           "| | Address | |", "|---|---|---|"]
    for nombre, addr, nota in filas:
        out.append("| %s | `%s` | %s |" % (nombre, addr, nota))
    return "\n".join(out)


def cuerpo(ruta, titulo):
    with io.open(os.path.join(RAIZ, ruta), encoding="utf-8") as f:
        texto = f.read().strip()
    # Los títulos de nivel 1 de cada archivo bajan un nivel para que el documento
    # entero tenga un solo h1 y un agente pueda seguir la jerarquía.
    texto = re.sub(r"^# ", "## ", texto, flags=re.M)
    texto = re.sub(r"^## ", "### ", texto, flags=re.M)
    return "\n".join(["", "---", "", "## " + titulo, "", texto, ""])


def main():
    partes = [CABECERA.replace("{DIRECCIONES}", direcciones())]
    partes.append(cuerpo("README.md", "The protocol"))
    partes.append(cuerpo("AGENTS.md", "For coding agents"))
    doc = "\n".join(partes).rstrip() + "\n"

    with io.open(SALIDA, "w", encoding="utf-8", newline="\n") as f:
        f.write(doc)

    print("escrito %s" % os.path.relpath(SALIDA, RAIZ))
    print("%d caracteres, %d lineas" % (len(doc), doc.count("\n")))


if __name__ == "__main__":
    main()
