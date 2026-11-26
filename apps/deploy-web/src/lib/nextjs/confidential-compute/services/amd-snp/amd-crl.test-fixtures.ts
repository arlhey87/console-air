import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Generates a DER-encoded CRL signed by the ARK in `signerDir` (which must contain `ark.pem` + `ark.key`),
 * revoking the given certificate serials — an empty list yields a clean CRL. Signed RSA-PSS/SHA-384 to
 * mirror AMD KDS, the only algorithm {@link verifyCrlSignature} accepts. Runs in a throwaway temp dir.
 */
export function generateCrl(signerDir: string, revokedSerials: string[]): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "amd-crl-"));
  try {
    const ossl = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
    // OpenSSL config values treat "\" as an escape, so Windows paths must use forward slashes.
    const cnfPath = (...segments: string[]) => join(...segments).replace(/\\/g, "/");

    const entries = revokedSerials.map(serial => `R\t350101000000Z\t240101000000Z\t${serial}\tunknown\t/CN=SEV-Milan\n`).join("");
    writeFileSync(join(dir, "index.txt"), entries);
    writeFileSync(join(dir, "crlnumber"), "1000\n");
    writeFileSync(
      join(dir, "ca.cnf"),
      [
        "[ca]",
        "default_ca = myca",
        "[myca]",
        `database = ${cnfPath(dir, "index.txt")}`,
        `crlnumber = ${cnfPath(dir, "crlnumber")}`,
        `certificate = ${cnfPath(signerDir, "ark.pem")}`,
        `private_key = ${cnfPath(signerDir, "ark.key")}`,
        "default_md = sha384",
        "default_crl_days = 30",
        ""
      ].join("\n")
    );
    ossl(["ca", "-config", "ca.cnf", "-gencrl", "-out", "crl.pem", "-sigopt", "rsa_padding_mode:pss", "-sigopt", "rsa_pss_saltlen:digest"]);
    ossl(["crl", "-in", "crl.pem", "-outform", "DER", "-out", "crl.der"]);
    return readFileSync(join(dir, "crl.der"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
