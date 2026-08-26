import crypto from "node:crypto";

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

const exportedPem = privateKey.export({ type: "pkcs1", format: "pem" });
if (typeof exportedPem !== "string") throw new Error("expected PEM string");
export const TEST_PRIVATE_KEY_PEM = exportedPem;
