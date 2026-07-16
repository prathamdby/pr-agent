import crypto from "node:crypto";

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

export const TEST_PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
