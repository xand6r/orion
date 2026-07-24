import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";

const MAX_SEED_LENGTH = 32;
const PDA_MARKER = Buffer.from("ProgramDerivedAddress");

function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromHex(Buffer.from(bytes).toString("hex"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-implementation of Solana's `PublicKey.findProgramAddressSync`, using
 * `@noble/curves` (small, audited, zero-dep) for the ed25519 on-curve check
 * instead of pulling in the full `@solana/web3.js` package. Verified against
 * pump.fun's own published Global PDA (seeds=["global"] under the pump
 * program) in tests/pda.test.ts.
 */
export function findProgramAddress(
  seeds: Array<Uint8Array | string>,
  programId: string,
): { address: string; bump: number } {
  const seedBuffers = seeds.map((seed) => {
    const buf = typeof seed === "string" ? Buffer.from(seed) : Buffer.from(seed);
    if (buf.length > MAX_SEED_LENGTH) {
      throw new Error("Max seed length exceeded");
    }
    return buf;
  });
  const programIdBytes = bs58.decode(programId);

  for (let bump = 255; bump >= 0; bump--) {
    const buffer = Buffer.concat([
      ...seedBuffers,
      Buffer.from([bump]),
      Buffer.from(programIdBytes),
      PDA_MARKER,
    ]);
    const hash = createHash("sha256").update(buffer).digest();
    if (!isOnCurve(hash)) {
      return { address: bs58.encode(hash), bump };
    }
  }
  throw new Error("Unable to find a viable program address bump");
}
