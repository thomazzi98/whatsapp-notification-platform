/**
 * Reduces a provider message identifier to the part that is stable across the
 * send and the acknowledgements that follow it.
 *
 * This exists because the two do not agree. Sending returns the raw message
 * identifier inside a key object:
 *
 *     { key: { remoteJid: "5515996751538@s.whatsapp.net",
 *              fromMe: true, id: "3EB055173A81C4963B7466" } }
 *
 * while the acknowledgement webhook reports a serialized form:
 *
 *     { id: "true_165515288932355@lid_3EB055173A81C4963B7466" }
 *
 * The middle segment differs between the two — the send names the phone number
 * and the acknowledgement names the account's linked-device identifier — so
 * comparing the serialized strings never matches. Only the final segment, the
 * message identifier itself, is the same on both sides.
 *
 * Storing that segment is therefore what lets a delivery receipt find the
 * notification it belongs to. A serialized identifier that carries no
 * underscore, as some engines return, is already in its stable form.
 */
export function normalizeProviderMessageId(providerMessageId: string): string {
  const segments = providerMessageId.split('_');
  const last = segments.at(-1) ?? '';

  return last.length > 0 ? last : providerMessageId;
}
