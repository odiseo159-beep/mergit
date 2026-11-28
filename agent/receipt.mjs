// El recibo que el agente deja en el pull request cuando un bounty se
// liquida, y cómo se sabe si el dinero se entregó o solo se acreditó.
//
// Vive aparte de on-event.mjs a propósito: ese fichero corre al importarse
// (lee el entorno y procesa el evento), así que ningún test podía cargarlo.
// Aquí no hay red ni variables de entorno, solo funciones puras.
import { formatEther } from "viem";

const SITE = "https://www.mergit.xyz";

/** Marca invisible del recibo, para saber si ya se escribió. */
export const RECIBO = "<!-- mergit-receipt -->";

/**
 * Cuánto de un pago quedó acreditado al desarrollador en vez de entregado:
 * el importe del `PaymentCredited` que lo acredita, o 0n si no hay ninguno.
 *
 * Cuenta solo un evento del mismo bounty, a la misma dirección (sin importar
 * mayúsculas) y por exactamente `payout`. La comisión de protocolo también
 * puede quedar acreditada cuando su destinatario rechaza el ETH, y ese
 * evento no cuenta: va a otra dirección y por otro importe.
 *
 * `events` son eventos ya decodificados, con la forma que dan viem y el
 * explorador: `{ eventName, args: { bountyId, to, amount } }`. Un evento
 * malformado se salta, nunca lanza: esto se lee sobre pagos ya hechos y un
 * recibo que falta se repone, pero una corrida caída no.
 */
export function creditedToDeveloper(events, { bountyId, developer, payout }) {
  const id = String(bountyId);
  const destino = String(developer ?? "").toLowerCase();
  let esperado;
  try {
    esperado = BigInt(payout);
  } catch {
    return 0n;
  }
  for (const ev of events ?? []) {
    if (ev?.eventName !== "PaymentCredited") continue;
    const a = ev.args ?? {};
    if (String(a.bountyId) !== id) continue;
    if (String(a.to ?? "").toLowerCase() !== destino) continue;
    let monto;
    try {
      monto = BigInt(a.amount);
    } catch {
      continue;
    }
    if (monto !== esperado) continue;
    return monto;
  }
  return 0n;
}

/**
 * El texto del recibo.
 *
 * Sin crédito (`credited` en 0n o ausente) es el recibo de siempre, byte a
 * byte: hay una prueba que lo fija. Con crédito dice lo que pasó: el pago se
 * aprobó, el ETH sigue en el escrow acreditado a esa dirección, y el dueño
 * de la dirección lo saca llamando a `withdrawTo(address)`. Nunca dice
 * "paid": no se pagó, se acreditó.
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
      `| Amount | ${formatEther(credited)} ETH (protocol fee ${formatEther(fee)} ETH) |`,
      `| Verified | merged, CI green on head commit \`${headSha.slice(0, 7)}\` |`,
      `| Evidence hash | \`${evidenceHash}\` |`,
      `| Transaction | [${tx.slice(0, 10)}…${tx.slice(-4)}](${url}) on GIWA Sepolia |`,
      ``,
      `The ETH is still in the escrow. The developer's address rejected the delivery, so the escrow kept the amount as a credit to that address instead of sending it. The owner of \`${developer}\` pulls it by calling \`withdrawTo(address)\` on the escrow.`,
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
