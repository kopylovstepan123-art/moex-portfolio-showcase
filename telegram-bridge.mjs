const encoder = new TextEncoder();
const context = encoder.encode("moex-telegram-update:v1");

function importKey(secret) {
  if (!/^[a-f0-9]{64}$/.test(secret ?? "")) throw new Error("Не задан ключ Telegram webhook.");
  const bytes = Uint8Array.from(secret.match(/../g), byte => parseInt(byte, 16));
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealUpdate(update, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importKey(secret);
  const data = encoder.encode(JSON.stringify(update));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: context }, key, data));
  return btoa(String.fromCharCode(...iv, ...encrypted));
}

export async function openUpdate(envelope, secret) {
  if (!/^[A-Za-z0-9+/]{38,1500}={0,2}$/.test(envelope ?? "")) throw new Error("Некорректное сообщение Telegram webhook.");
  try {
    const packed = Uint8Array.from(atob(envelope), char => char.charCodeAt(0));
    const key = await importKey(secret);
    const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: packed.subarray(0, 12), additionalData: context }, key, packed.subarray(12));
    const update = JSON.parse(new TextDecoder().decode(data));
    if (!Number.isSafeInteger(update.update_id) || update.update_id <= 0 || !update.message) throw new Error();
    return update;
  } catch {
    throw new Error("Не удалось проверить сообщение Telegram webhook.");
  }
}
