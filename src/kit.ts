/**
 * kit.ts
 * Sends a landing-page signup to Kit (formerly ConvertKit), the free email
 * service that holds the subscriber list. Names and emails go straight from
 * the visitor's browser to Kit and never touch this repo or tolara.db.
 *
 * This uses Kit's public form endpoint, the same one Kit's own embed code
 * posts to, so it needs only the form's ID, which is not a secret. Never put
 * a Kit API key here: anything in the page is readable by every visitor.
 *
 * Set the ID in .env.local (gitignored):
 *   VITE_KIT_FORM_ID=1234567
 * It's the number in the form's URL in Kit, or in the action of its
 * Embed > HTML code (".../forms/1234567/subscriptions"); if that code's
 * action or field names differ from the ones below, match them. The last name needs
 * a custom field called last_name in Kit; first name and email are built in.
 */

const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};
export const KIT_FORM_ID = /^\d+$/.test(env.VITE_KIT_FORM_ID ?? "") ? env.VITE_KIT_FORM_ID! : null;

export interface Signup {
  // Optional: "Already signed up?" sends just the email, and Kit keeps the
  // names it already has for that subscriber.
  firstName?: string;
  lastName?: string;
  email: string;
}

export async function subscribe({ firstName, lastName, email }: Signup): Promise<void> {
  if (!KIT_FORM_ID) throw new Error("Signups aren't connected yet.");
  const body = new URLSearchParams({ email_address: email });
  if (firstName) body.set("fields[first_name]", firstName);
  if (lastName) body.set("fields[last_name]", lastName);
  const res = await fetch(`https://app.kit.com/forms/${KIT_FORM_ID}/subscriptions`, {
    method: "POST",
    headers: { Accept: "application/json" },
    body,
  });
  // A good signup comes back as HTTP 200 with {"status":"success", ...}.
  let data: { status?: string; errors?: { messages?: unknown[] } } | null = null;
  try {
    data = await res.json();
  } catch {
    /* not JSON */
  }
  if (res.ok && data?.status === "success") return;
  const message = typeof data?.errors?.messages?.[0] === "string" ? data.errors.messages[0] : "";
  throw new Error(message || "That didn't go through. Try again in a moment.");
}
