// Datos reales de MergitEscrow en GIWA Sepolia, leídos desde el explorador (Blockscout, CORS
// abierto). Nada de aquí se inventa: si el explorador no responde, se usa la foto tomada el
// 22-sep-2026 de esos mismos eventos, y la página lo dice.
//
// Los bounties 1 y 2 fueron pruebas del contrato del 31-jul, sin un pull request real detrás.
// Por eso el feed muestra desde el 3: los pagos que disparó un PR mergeado de verdad.

export const ESCROW = "0xffcf206ce1474263aaa3336fb9c8bc3d632e5879";
export const EXPLORER = "https://sepolia-explorer.giwa.io";
const FIRST_REAL = 3;

// Qué pull request pagó cada bounty (el evento guarda el hash de la evidencia, no la URL).
export const PULLS = {
  3: { pr: "mergit-demo#1", url: "https://github.com/odiseo159-beep/mergit-demo/pull/1", merged: "2026-09-08T04:45:17Z", auto: false },
  4: { pr: "mergit-demo#2", url: "https://github.com/odiseo159-beep/mergit-demo/pull/2", merged: "2026-09-19T00:49:36Z", auto: true },
};

const SNAPSHOT = [
  { kind: "BountySettled", tx: "0x567a7c4b851b8b09f10d3aee2caea4883c6859a7aec625e2d1e750c7c161bc44", block: 36433880, time: "2026-09-19T00:49:56Z", bountyId: "4", developer: "0x23E8541dA96158d342477D694274E27639807686", paidToDeveloper: "492500000000000", protocolFee: "7500000000000", evidenceHash: "0x3eb6afb326b95927705d09685bff0dab8066cc572809fa47437c85648b1ec805" },
  { kind: "BountyPosted", tx: "0x3154dfe1ddb8d76a8b3777761b3cf54ba762b9b5c65b746e21a06fc2cb78afae", block: 36433694, time: "2026-09-19T00:46:50Z", bountyId: "4", amount: "500000000000000" },
  { kind: "BountySettled", tx: "0x09e7522eca66b87abfc17e8fb159615c08105e77f678a9c2f8f6491c53d553a4", block: 35521994, time: "2026-09-08T11:31:50Z", bountyId: "3", developer: "0x23E8541dA96158d342477D694274E27639807686", paidToDeveloper: "492500000000000", protocolFee: "7500000000000", evidenceHash: "0xde961a4268e2d4797db3b0706316df616a3d04bd37b396abe61be55a0b6a9665" },
  { kind: "BountyPosted", tx: "0x8e11e2c255ab7a38f5636650f293e7475b22833ff0706c20b6eaaa02298e75b7", block: 35498297, time: "2026-09-08T04:56:53Z", bountyId: "3", amount: "500000000000000" },
];

export const eth = (wei) => {
  const s = (Number(BigInt(wei)) / 1e18).toFixed(7).replace(/0+$/, "").replace(/\.$/, "");
  return s;
};
export const short = (h, a = 6, b = 4) => `${h.slice(0, a)}…${h.slice(-b)}`;

/** { settled: [...], posted: [...], live: bool } con los eventos más nuevos primero. */
export async function loadActivity() {
  let events = SNAPSHOT;
  let live = false;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const res = await fetch(`${EXPLORER}/api/v2/addresses/${ESCROW}/logs`, { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    events = data.items
      .filter((it) => it.decoded)
      .map((it) => {
        const p = Object.fromEntries(it.decoded.parameters.map((x) => [x.name, x.value]));
        return { kind: it.decoded.method_call.split("(")[0], tx: it.transaction_hash, block: it.block_number, time: it.block_timestamp, ...p };
      });
    live = true;
  } catch {
    // se queda con la foto
  }
  const real = events.filter((e) => Number(e.bountyId) >= FIRST_REAL);
  return {
    live,
    settled: real.filter((e) => e.kind === "BountySettled"),
    posted: real.filter((e) => e.kind === "BountyPosted"),
  };
}
