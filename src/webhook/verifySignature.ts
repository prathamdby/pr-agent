import crypto from "node:crypto";

/**
 * Validates `X-Hub-Signature-256` (`sha256=<hex>`).
 */
export function verifyGithubWebhookSignature(secret: string, rawBody: Buffer, signatureHeader: string | undefined): boolean {
	if (!signatureHeader?.startsWith("sha256=")) return false;
	const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
	const received = signatureHeader.slice("sha256=".length);

	const expectedBuf = Buffer.from(expected, "utf8");
	const receivedBuf = Buffer.from(received, "utf8");
	if (expectedBuf.length !== receivedBuf.length) return false;
	return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}
