import type { LoggerService } from "@akashnetwork/logging";
import type { NextApiRequest, NextApiResponse } from "next";
import { describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";

import type { FixedWindowRateLimiter } from "../rateLimit/fixedWindowRateLimiter";
import type { VerifyAttestationResponse } from "./http-schemas/attestation.schema";
import { MAX_GPU_REPORTS } from "./http-schemas/attestation.schema";
import type { AttestationService } from "./services/attestation.service";
import type { DEPENDENCIES } from "./validate.handler";
import { attestationValidateHandler } from "./validate.handler";

const validBody = {
  nonce: "bm9uY2U=",
  report: "Y3B1LXJlcG9ydA==",
  tee_platform: "snp",
  gpu_reports: []
};

describe(attestationValidateHandler.name, () => {
  it("verifies the posted evidence and returns the per-report verdicts", async () => {
    const verdicts: VerifyAttestationResponse = {
      overall: "valid",
      nonce: "bm9uY2U=",
      reports: [{ kind: "cpu", vendor: "amd-sev-snp", status: "valid", detail: "ok" }]
    };
    const { req, res, service } = setup({ method: "POST", body: validBody });
    service.verify.mockResolvedValue(verdicts);

    await run(req, res, service);

    expect(service.verify).toHaveBeenCalledWith(expect.objectContaining({ nonce: "bm9uY2U=", tee_platform: "snp", cert_chain: "", auxblob: "" }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(verdicts);
  });

  it("rejects non-POST methods with 405", async () => {
    const { req, res, service } = setup({ method: "GET", body: validBody });

    await run(req, res, service);

    expect(res.status).toHaveBeenCalledWith(405);
    expect(service.verify).not.toHaveBeenCalled();
  });

  it("rejects a malformed request body with 400", async () => {
    const { req, res, service } = setup({ method: "POST", body: { report: "x" } });

    await run(req, res, service);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(service.verify).not.toHaveBeenCalled();
  });

  it("verifies up to the maximum number of GPU reports", async () => {
    const gpuReports = Array.from({ length: MAX_GPU_REPORTS }, (_, index) => ({ device_index: index, report: "Z3B1" }));
    const { req, res, service } = setup({ method: "POST", body: { ...validBody, gpu_reports: gpuReports } });
    service.verify.mockResolvedValue({ overall: "valid", nonce: "bm9uY2U=", reports: [] });

    await run(req, res, service);

    expect(service.verify).toHaveBeenCalledWith(expect.objectContaining({ gpu_reports: gpuReports }));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("rejects more GPU reports than the maximum with 400", async () => {
    const gpuReports = Array.from({ length: MAX_GPU_REPORTS + 1 }, (_, index) => ({ device_index: index, report: "Z3B1" }));
    const { req, res, service } = setup({ method: "POST", body: { ...validBody, gpu_reports: gpuReports } });

    await run(req, res, service);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(service.verify).not.toHaveBeenCalled();
  });

  it("reports a bounded number of issues for an oversized array of invalid GPU reports", async () => {
    const { req, res, service } = setup({ method: "POST", body: { ...validBody, gpu_reports: Array(100_000).fill(0) } });

    await run(req, res, service);

    const { details } = res.json.mock.calls[0][0] as { details: { fieldErrors: { gpu_reports: string[] } } };
    expect(res.status).toHaveBeenCalledWith(400);
    expect(details.fieldErrors.gpu_reports.length).toBeLessThanOrEqual(MAX_GPU_REPORTS + 2);
  });

  it("returns 500 when verification throws unexpectedly", async () => {
    const { req, res, service } = setup({ method: "POST", body: validBody });
    service.verify.mockRejectedValue(new Error("boom"));

    await run(req, res, service);

    expect(res.status).toHaveBeenCalledWith(500);
  });

  describe("when the client exceeds the rate limit", () => {
    it("returns 429 with Retry-After and skips verification", async () => {
      const { req, res, service, rateLimiter } = setup({ method: "POST", body: validBody });
      rateLimiter.consume.mockReturnValue({ allowed: false, retryAfterSeconds: 42 });

      await run(req, res, service, rateLimiter);

      expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "42");
      expect(res.status).toHaveBeenCalledWith(429);
      expect(service.verify).not.toHaveBeenCalled();
    });
  });

  it("keys the rate limit on the client IP forwarded by the reverse proxy", async () => {
    const { req, res, service, rateLimiter } = setup({ method: "POST", body: validBody, headers: { "x-real-ip": "203.0.113.7" } });
    service.verify.mockResolvedValue({ overall: "valid", nonce: "bm9uY2U=", reports: [] });

    await run(req, res, service, rateLimiter);

    expect(rateLimiter.consume).toHaveBeenCalledWith("203.0.113.7");
  });

  function setup(input: { method: string; body: unknown; headers?: Record<string, string> }) {
    const req = { method: input.method, body: input.body, headers: input.headers ?? {} } as unknown as NextApiRequest;
    const res = mock<NextApiResponse>();
    res.status.mockReturnValue(res);
    res.json.mockReturnValue(res);
    const service = mock<AttestationService>();
    const rateLimiter = mock<FixedWindowRateLimiter>();
    rateLimiter.consume.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
    return { req, res, service, rateLimiter };
  }

  function run(req: NextApiRequest, res: NextApiResponse, service: AttestationService, rateLimiter?: FixedWindowRateLimiter) {
    const allowAll = mock<FixedWindowRateLimiter>({ consume: () => ({ allowed: true, retryAfterSeconds: 0 }) });
    return attestationValidateHandler(req, res, {
      createAttestationService: () => service,
      logger: mock<LoggerService>(),
      rateLimiter: rateLimiter ?? allowAll
    } as typeof DEPENDENCIES);
  }
});
