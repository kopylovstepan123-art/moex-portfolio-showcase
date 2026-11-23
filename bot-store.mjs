import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const branch = "bot-access";
const statePath = "telegram-access.enc";
const validChatId = id => typeof id === "string" && /^[1-9]\d*$/.test(id);
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;

export function accessKeys(secret) {
  if (typeof secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
    throw new Error("Не задан ключ доступа Telegram в GitHub Actions.");
  }
  const key = Buffer.from(secret, "base64url");
  return {
    encryption: createHmac("sha256", key).update("state-encryption:v1").digest(),
    code: (instance, generation) => createHmac("sha256", key).update(`shared-code:v1:${instance}:${generation}`)
      .digest().subarray(0, 18).toString("base64url"),
  };
}

export function accessStore(encryptionKey, repository, token) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") || !token) {
    throw new Error("Не задан доступ GitHub к списку гостей Telegram.");
  }
  const repositoryUrl = `https://api.github.com/repos/${repository}`;
  const contents = `/contents/${statePath}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const context = Buffer.from(`telegram-access:v1:${repository}`);

  async function request(method, path, body) {
    try {
      return await fetch(repositoryUrl + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error", signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new Error("Не удалось связаться с хранилищем доступа GitHub.");
    }
  }

  function decode(blob) {
    const packed = Buffer.from(blob.content, "base64");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, packed.subarray(0, 12));
    decipher.setAAD(context);
    decipher.setAuthTag(packed.subarray(12, 28));
    const bytes = Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]);
    const state = JSON.parse(bytes);
    if (!positiveInteger(state.enabledAt) || !/^[A-Za-z0-9_-]{22}$/.test(state.instance)
        || !Number.isSafeInteger(state.generation) || state.generation < 0
        || !Array.isArray(state.guests) || !state.guests.every(validChatId)
        || (state.lastMutation && !(positiveInteger(state.lastMutation.id) && positiveInteger(state.lastMutation.at)))) {
      throw new Error("Invalid access state");
    }
    return { state, sha: blob.sha };
  }

  return {
    async read() {
      const response = await request("GET", `${contents}?ref=${branch}`);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`GitHub не прочитал список гостей (HTTP ${response.status}).`);
      const { sha } = await response.json();
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("GitHub не подтвердил версию списка гостей.");
      const blobResponse = await request("GET", `/git/blobs/${sha}`);
      if (!blobResponse.ok) throw new Error(`GitHub не прочитал файл доступа (HTTP ${blobResponse.status}).`);
      try {
        const blob = await blobResponse.json();
        if (blob.sha !== sha || blob.encoding !== "base64") throw new Error("Invalid access blob");
        return decode(blob);
      } catch {
        throw new Error("Не удалось проверить зашифрованный список гостей.");
      }
    },
    async write(state, sha) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
      cipher.setAAD(context);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state)), cipher.final()]);
      const content = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
      const response = await request("PUT", contents, {
        branch, sha, content, message: "Update encrypted Telegram access",
      });
      if (!response.ok) throw new Error(`GitHub не сохранил список гостей (HTTP ${response.status}).`);
      await response.body?.cancel();
    },
  };
}
