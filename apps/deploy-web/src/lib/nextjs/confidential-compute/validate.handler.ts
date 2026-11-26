import { LoggerService } from "@akashnetwork/logging";
import type { NextApiRequest, NextApiResponse } from "next";

import { FixedWindowRateLimiter, getClientKey } from "../rateLimit/fixedWindowRateLimiter";
import type { VerifyAttestationResponse } from "./http-schemas/attestation.schema";
import { VerifyAttestationRequestSchema } from "./http-schemas/attestation.schema";
import { createAttestationService } from "./create-attestation-service";

export const DEPENDENCIES = {
  createAttestationService,
  logger: new LoggerService({ name: "attestation-validate" }),
  // The route is unauthenticated and each call fans out to AMD/NVIDIA/Intel services; validation is a
  // manual, on-demand action, so a small per-client budget only stops scripted abuse.
  rateLimiter: new FixedWindowRateLimiter({ limit: 10, windowMs: 60_000 })
};

export type AttestationValidateApiResponse = VerifyAttestationResponse | { error: string; details?: unknown };

/**
 * Self-hosted confidential-compute attestation validation (CON-552). Replaces the upstream apps/api Hono route:
 * the tenant POSTs the downloaded evidence (verbatim vendor field names) and receives a per-report verdict.
 *
 * The request schema is intentionally lenient about the binary blobs — a malformed report surfaces as a
 * per-report `invalid`/`unverifiable` verdict from the verifier, never a 400 that would hide the other reports.
 */
export async function attestationValidateHandler(
  req: NextApiRequest,
  res: NextApiResponse<AttestationValidateApiResponse>,
  dependencies: typeof DEPENDENCIES = DEPENDENCIES
): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const rateLimit = dependencies.rateLimiter.consume(getClientKey(req));
  if (!rateLimit.allowed) {
    res.setHeader("Retry-After", String(rateLimit.retryAfterSeconds));
    res.status(429).json({ error: "Too many attestation validation requests" });
    return;
  }

  const parsed = VerifyAttestationRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid attestation request body", details: parsed.error.flatten() });
    return;
  }

  try {
    const result = await dependencies.createAttestationService().verify(parsed.data);
    res.status(200).json(result);
  } catch (error) {
    dependencies.logger.error({ event: "ATTESTATION_VALIDATE_FAILED", error });
    res.status(500).json({ error: "Attestation validation could not be completed" });
  }
}
