import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { findProgramAddress } from "../src/onchain/pda.js";

const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

describe("findProgramAddress", () => {
  it("reproduces pump.fun's published Global PDA (seeds=['global'])", () => {
    // Ground truth from pump.fun's own public docs repo: the Global account
    // lives at 4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf, PDA-derived from
    // ["global"] under the pump program. https://github.com/pump-fun/pump-public-docs
    const { address, bump } = findProgramAddress([Buffer.from("global")], PUMP_PROGRAM_ID);
    expect(address).toBe("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
    expect(bump).toBe(255);
  });

  it("throws on an oversized seed", () => {
    expect(() =>
      findProgramAddress([Buffer.alloc(33)], PUMP_PROGRAM_ID),
    ).toThrow(/Max seed length exceeded/);
  });

  it("is deterministic for the same seeds and program", () => {
    const mint = bs58.decode("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    const a = findProgramAddress([Buffer.from("bonding-curve"), mint], PUMP_PROGRAM_ID);
    const b = findProgramAddress([Buffer.from("bonding-curve"), mint], PUMP_PROGRAM_ID);
    expect(a).toEqual(b);
  });
});
