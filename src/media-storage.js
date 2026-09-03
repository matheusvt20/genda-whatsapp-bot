import { randomUUID } from "node:crypto";

export const DEFAULT_MEDIA_RETENTION_MS = 15 * 24 * 60 * 60 * 1000;

function encodedStoragePath(storagePath) {
  return storagePath.split("/").map(encodeURIComponent).join("/");
}

function safeObjectKey(value) {
  const sanitized = String(value || "").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 160);
  return sanitized || randomUUID();
}

function mediaExtension(mimeType, fileName) {
  const cleanMime = String(mimeType || "application/octet-stream").split(";")[0].trim().toLowerCase();
  const knownExtensions = {
    "audio/aac": "aac",
    "audio/m4a": "m4a",
    "audio/mp4": "m4a",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/opus": "opus",
    "audio/wav": "wav",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "application/pdf": "pdf",
  };
  if (knownExtensions[cleanMime]) return knownExtensions[cleanMime];

  const fileExtension = String(fileName || "").match(/\.([a-zA-Z0-9]{1,10})$/)?.[1]?.toLowerCase();
  if (fileExtension) return fileExtension;

  const mimeExtension = cleanMime.split("/")[1]?.replace(/[^a-zA-Z0-9]+/g, "").slice(0, 10);
  return mimeExtension || "bin";
}

function absoluteSignedUrl(supabaseUrl, signedPath) {
  if (/^https?:\/\//i.test(signedPath)) return signedPath;
  return `${supabaseUrl}/storage/v1${signedPath.startsWith("/") ? "" : "/"}${signedPath}`;
}

export function createMediaStorage({
  supabaseUrl,
  serviceRoleKey,
  bucket = "whatsapp-media",
  retentionMs = DEFAULT_MEDIA_RETENTION_MS,
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  const baseUrl = String(supabaseUrl || "").replace(/\/+$/, "");
  const retention = Number.isFinite(Number(retentionMs)) && Number(retentionMs) > 0
    ? Number(retentionMs)
    : DEFAULT_MEDIA_RETENTION_MS;
  const signedUrlTtlSeconds = Math.max(60, Math.ceil(retention / 1000));

  const headers = (extra = {}) => ({
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    ...extra,
  });

  async function deleteObject(storagePath) {
    if (!baseUrl || !serviceRoleKey || !storagePath) return false;
    const response = await fetchImpl(
      `${baseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedStoragePath(storagePath)}`,
      { method: "DELETE", headers: headers() },
    );
    return response.ok || response.status === 404;
  }

  async function persistBuffer({ buffer, userId, messageId, mimeType, fileName }) {
    if (!baseUrl || !serviceRoleKey || !Buffer.isBuffer(buffer) || !buffer.length || !userId) return null;

    const createdAt = new Date(now());
    const datePath = createdAt.toISOString().slice(0, 10).replaceAll("-", "/");
    const storagePath = `${safeObjectKey(userId)}/${datePath}/${safeObjectKey(messageId)}.${mediaExtension(mimeType, fileName)}`;
    const encodedPath = encodedStoragePath(storagePath);
    const cleanMimeType = String(mimeType || "application/octet-stream").trim() || "application/octet-stream";
    const expiresAt = new Date(createdAt.getTime() + retention).toISOString();

    const uploadResponse = await fetchImpl(
      `${baseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`,
      {
        method: "POST",
        headers: headers({ "content-type": cleanMimeType, "x-upsert": "true" }),
        body: buffer,
      },
    );
    if (!uploadResponse.ok) {
      throw new Error(`media storage upload failed (${uploadResponse.status})`);
    }

    try {
      const signResponse = await fetchImpl(
        `${baseUrl}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${encodedPath}`,
        {
          method: "POST",
          headers: headers({ "content-type": "application/json" }),
          body: JSON.stringify({ expiresIn: signedUrlTtlSeconds }),
        },
      );
      if (!signResponse.ok) throw new Error(`media URL signing failed (${signResponse.status})`);
      const signPayload = await signResponse.json();
      const signedPath = signPayload?.signedURL || signPayload?.signedUrl;
      if (!signedPath) throw new Error("media URL signing returned no URL");

      const metadataResponse = await fetchImpl(
        `${baseUrl}/rest/v1/whatsapp_media_objects?on_conflict=storage_path`,
        {
          method: "POST",
          headers: headers({
            "content-type": "application/json",
            Prefer: "resolution=merge-duplicates,return=minimal",
          }),
          body: JSON.stringify({
            user_id: userId,
            storage_path: storagePath,
            mime_type: cleanMimeType,
            size_bytes: buffer.length,
            expires_at: expiresAt,
          }),
        },
      );
      if (!metadataResponse.ok) throw new Error(`media metadata save failed (${metadataResponse.status})`);

      return absoluteSignedUrl(baseUrl, signedPath);
    } catch (error) {
      await deleteObject(storagePath).catch(() => false);
      throw error;
    }
  }

  async function cleanupExpired({ batchSize = 100, maxBatches = 10 } = {}) {
    if (!baseUrl || !serviceRoleKey) return { checked: 0, deleted: 0 };
    let checked = 0;
    let deleted = 0;

    for (let batch = 0; batch < maxBatches; batch += 1) {
      const cutoff = new Date(now()).toISOString();
      const query = new URLSearchParams({
        select: "id,storage_path",
        expires_at: `lte.${cutoff}`,
        order: "expires_at.asc",
        limit: String(batchSize),
      });
      const listResponse = await fetchImpl(
        `${baseUrl}/rest/v1/whatsapp_media_objects?${query}`,
        { headers: headers() },
      );
      if (!listResponse.ok) throw new Error(`expired media lookup failed (${listResponse.status})`);

      const rows = await listResponse.json();
      if (!Array.isArray(rows) || rows.length === 0) break;
      checked += rows.length;

      for (const row of rows) {
        const objectDeleted = await deleteObject(row.storage_path);
        if (!objectDeleted) continue;

        const metadataDeleted = await fetchImpl(
          `${baseUrl}/rest/v1/whatsapp_media_objects?id=eq.${encodeURIComponent(row.id)}`,
          { method: "DELETE", headers: headers({ Prefer: "return=minimal" }) },
        );
        if (metadataDeleted.ok) deleted += 1;
      }

      if (rows.length < batchSize) break;
    }

    return { checked, deleted };
  }

  return { cleanupExpired, persistBuffer };
}
