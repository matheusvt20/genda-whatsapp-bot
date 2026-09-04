export async function assertMessageStatusWebhookAccepted(response) {
  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`Supabase status webhook failed ${response.status}: ${responseText}`);
  }

  let result = null;
  if (responseText) {
    try {
      result = JSON.parse(responseText);
    } catch {
      throw new Error("Supabase status webhook returned an invalid response");
    }
  }

  if (result?.success === false) {
    throw new Error(`Supabase status webhook rejected the update: ${result.error || "unknown error"}`);
  }

  // A confirmação pode chegar antes de a mensagem ser inserida no banco.
  // Enquanto o registro não existir, mantenha o evento na outbox para retry.
  // Se ele já existe em um estado mais avançado, `found: true` encerra o retry.
  if (result?.updated === false && result?.found !== true) {
    throw new Error("WhatsApp message status is not reconciled yet");
  }

  return result;
}
