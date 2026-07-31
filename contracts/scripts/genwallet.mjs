// Genera una clave NUEVA, exclusiva para GIWA Sepolia testnet.
// La clave privada nunca se imprime en consola: solo se escribe al archivo secreto.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const OUT = resolve(process.cwd(), '..', 'WALLETS.secret.json');

if (existsSync(OUT)) {
  console.error(`✗ ${OUT} ya existe. Bórralo manualmente si quieres regenerar.`);
  process.exit(1);
}

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify(
    {
      _warning: 'TESTNET ONLY. No enviar fondos reales a esta dirección. No commitear este archivo.',
      network: 'giwa-sepolia',
      chainId: 91342,
      createdAt: new Date().toISOString(),
      deployer: { address: account.address, privateKey },
    },
    null,
    2,
  ),
  { mode: 0o600 },
);

console.log('✓ Wallet de testnet creada');
console.log('  archivo   :', OUT);
console.log('  dirección :', account.address);
