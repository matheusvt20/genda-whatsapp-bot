import fs from "node:fs/promises";
import path from "node:path";

function parseCredentials(raw) {
  const credentials = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!credentials?.noiseKey || !credentials?.signedIdentityKey || !credentials?.signedPreKey) {
    throw new Error("invalid stored WhatsApp credentials");
  }
  return credentials;
}

// The volume contains credentials AND Signal keys. A remote credentials-only
// backup must not roll back counters while the newer Signal keys stay on disk.
export async function restoreSessionCredentials(localPath, downloadCredentials) {
  const filename = path.join(localPath, "creds.json");
  await fs.mkdir(localPath, { recursive: true });
  let invalidLocal = false;
  try {
    parseCredentials(await fs.readFile(filename, "utf8"));
    return "local";
  } catch (error) {
    if (error?.code !== "ENOENT") {
      if (!(error instanceof SyntaxError) && error?.message !== "invalid stored WhatsApp credentials") throw error;
      invalidLocal = true;
    }
  }

  const remote = await downloadCredentials();
  if (!remote) {
    if (invalidLocal) throw new Error("local WhatsApp credentials are invalid and no backup is available");
    return "new";
  }
  const credentials = parseCredentials(remote);
  const temporary = `${filename}.restore`;
  await fs.writeFile(temporary, JSON.stringify(credentials), { mode: 0o600 });
  await fs.rename(temporary, filename);
  return "remote";
}

export function createCredentialSaver({ saveLocal, readLocal, upload, onBackupError = () => {}, retryDelay = () => Promise.resolve() }) {
  let tail = Promise.resolve();
  let closed = false;
  return {
    save() {
      const result = tail.catch(() => undefined).then(async () => {
        if (closed) return;
        await saveLocal();
        if (closed) return;
        const credentials = parseCredentials(await readLocal());
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          if (closed) return;
          try {
            await upload(credentials);
            return;
          } catch {
            // Backup failure must not discard the valid local session. Do not
            // log provider responses: they can contain credentials or URLs.
            onBackupError(attempt);
            if (attempt < 3) await retryDelay();
          }
        }
      });
      tail = result;
      return result;
    },
    async close() {
      closed = true;
      await tail.catch(() => undefined);
    },
  };
}
