import crypto from "node:crypto";

export function verifyGithubWebhookSignature(
  secret: string,
  rawBody: Buffer,
  signatureHeader: string | undefined,
) {
  if (!signatureHeader?.startsWith("sha256="))
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const received = signatureHeader.slice("sha256=".length);

  const expectedBuf = Buffer.from(expected, "utf8");
  const receivedBuf = Buffer.from(received, "utf8");
  if (expectedBuf.length !== receivedBuf.length)
    return ((pinnedReturn: boolean) => pinnedReturn)(false);
  return ((pinnedReturn: boolean) => pinnedReturn)(
    crypto.timingSafeEqual(expectedBuf, receivedBuf),
  );
}
