// Recibos del agente Mergit: qué escribe en el pull request cuando un bounty
// se liquida. Sin red y sin variables de entorno, para que un test pueda
// importarlo. Antes vivía en on-event.mjs, pero ese fichero corre al
// importarse, así que ninguna prueba podía cargarlo.
import { formatEther } from "viem";

const SITE = "https://www.mergit.xyz";

/** Marca invisible del recibo, para saber si ya se escribió. */
export const RECIBO = "<!-- mergit-receipt -->";

/**
 * Cuánto se acreditó al desarrollador, o 0n.
 *
 * Cuenta solo un `PaymentCredited` del mismo bounty, a la misma dirección
 * (ignorando mayúsculas) y por exactamente `payout`. Un crédito de comisión
 * de protocolo —a otra dirección o por otro importe— no cuenta: el dinero del
 * desarrollador que quedó en el escrow es solo este.
 *
 * `events` son eventos decodificados: `{ eventName, args: { bountyId, to, amount } }`.
 */
export function creditedToDeveloper(events, { bountyId, developer, payout }) {
  const id = String(bountyId);
  const to = String(developer ?? "").toLowerCase();
  const esperado = BigInt(payout);
  for (const ev of events ?? []) {
    if (ev.eventName !== "PaymentCredited") continue;
    const a = ev.args ?? {};
    if (String(a.bountyId) !== id) continue;
    if (String(a.to ?? "").toLowerCase() !== to) continue;
    if (BigInt(a.amount) !== esperado) continue;
    return BigInt(a.amount);
  }
  return 0n;
}

/**
 * El texto del recibo. Con `credited > 0n` dice que el pago fue aprobado pero
 * sigue en el escrow, y nunca dice "paid". Sin crédito, el recibo entregado es
 * byte a byte el de siempre.
 */
export function recibo({ bountyId, developer, via, author, paid, fee, credited = 0n, headSha, evidenceHash, tx, url }) {
  if (credited > 0n) {
    return [
      RECIBO,
      `**Mergit approved this payment. It is waiting to be withdrawn.**`,
      ``,
      `| | |`,
      `|---|---|`,
      `| Bounty | #${bountyId} |`,
      `| Credited to | \`${developer}\` — ${via} |`,
      `| Amount | ${formatEther(credited)} ETH is still in the escrow, credited to this address |`,
      `| Verified | merged, CI green on head commit \`${headSha.slice(0, 7)}\` |`,
      `| Evidence hash | \`${evidenceHash}\` |`,
      `| Transaction | [${tx.slice(0, 10)}…${tx.slice(-4)}](${url}) on GIWA Sepolia |`,
      ``,
      `The ETH was not delivered: the developer's address rejected it, so the escrow kept it in \`owed\`. The owner of \`${developer}\` calls \`withdrawTo(address)\` on the escrow to pull it.`,
      ``,
      `Your record: ${SITE}/p/${author}`,
      ``,
      `Put this in your profile README and it will show what your merged work earned, read straight from the chain:`,
      ``,
      "```markdown",
      `[![Mergit](${SITE}/badge/${author}.svg)](${SITE}/p/${author})`,
      "```",
      ``,
      `Merge it. Get credited.`,
    ].join("\n");
  }
  // Entregado: el recibo de siempre, sin cambiar ni un byte.
  return [
    RECIBO,
    `**Mergit paid this pull request.**`,
    ``,
    `| | |`,
    `|---|---|`,
    `| Bounty | #${bountyId} |`,
    `| Paid to | \`${developer}\` — ${via} |`,
    `| Amount | ${formatEther(paid)} ETH (protocol fee ${formatEther(fee)} ETH) |`,
    `| Verified | merged, CI green on head commit \`${headSha.slice(0, 7)}\` |`,
    `| Evidence hash | \`${evidenceHash}\` |`,
    `| Transaction | [${tx.slice(0, 10)}…${tx.slice(-4)}](${url}) on GIWA Sepolia |`,
    ``,
    `Your record: ${SITE}/p/${author}`,
    ``,
    `Put this in your profile README and it will show what your merged work was paid, read straight from the chain:`,
    ``,
    "```markdown",
    `[![Mergit](${SITE}/badge/${author}.svg)](${SITE}/p/${author})`,
    "```",
    ``,
    `Merge it. Get paid.`,
  ].join("\n");
}
