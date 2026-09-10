import PostalMime from "postal-mime";

const SENDER_DOMAIN = "nayapay.com";
const MAX_ATTEMPTS = 3;

export default {
  async email(message, env, ctx) {
    const email = await PostalMime.parse(message.raw);

    if (!isAuthenticNayaPay(email.headers)) {
      const ar = email.headers.find((h) => h.key === "authentication-results");
      console.warn("dropped: not authenticated nayapay mail", {
        from: email.from?.address,
        subject: email.subject,
        authResults: ar?.value,
      });
      return;
    }

    const text = await serialise(email);
    await postWithRetry(env, text);
  },
};

/**
 * Trust only the topmost Authentication-Results header. Cloudflare's MX prepends it,
 * so a sender can't forge anything above it. Lower ones (Google's, or injected) are ignored.
 * DMARC pass for header.from=nayapay.com means aligned DKIM, which survives the Gmail forward.
 */
function isAuthenticNayaPay(headers) {
  const ar = headers.find((h) => h.key === "authentication-results");
  if (!ar) return false;

  const value = ar.value.replace(/\s+/g, " ").trim();
  if (!/^mx\.cloudflare\.net\b/i.test(value)) return false;

  return value
    .split(";")
    .some((clause) =>
      /\bdmarc=pass\b/i.test(clause) &&
      new RegExp(`\\bheader\\.from=${SENDER_DOMAIN.replace(".", "\\.")}\\b`, "i").test(clause)
    );
}

/**
 * NayaPay's template renders every detail row as two <p class="general-text-3"> cells
 * (label, value), with section headings in <span class="general-text-2">, and the
 * timestamp in the summary card's <p class="summary-text">. Outlook conditional
 * comments wrap every value; HTMLRewriter surfaces those as comments, not text,
 * so they never leak in.
 */
async function extract(html) {
  const nodes = [];
  const collect = (kind) => ({
    element() {
      nodes.push({ kind, text: "" });
    },
    text(chunk) {
      nodes[nodes.length - 1].text += chunk.text;
    },
  });

  await new HTMLRewriter()
    .on("span.general-text-2", collect("section"))
    .on("p.general-text-3", collect("cell"))
    .on("p.summary-text", collect("summary"))
    .transform(new Response(html))
    .arrayBuffer();

  const fields = new Map();
  let timestamp = null;
  let pendingLabel = null;

  for (const node of nodes) {
    const text = clean(node.text);

    if (node.kind === "summary") {
      if (/\d{1,2} \w{3} \d{4}, \d{1,2}:\d{2} [AP]M/i.test(text)) timestamp = text;
    } else if (node.kind === "section") {
      pendingLabel = null;
    } else if (pendingLabel === null) {
      pendingLabel = text.toLowerCase();
    } else {
      if (!fields.has(pendingLabel)) fields.set(pendingLabel, text);
      pendingLabel = null;
    }
  }

  return { timestamp, fields };
}

async function serialise(email) {
  const subject = clean(email.subject || "NayaPay notification");
  const { timestamp, fields } = email.html
    ? await extract(email.html)
    : { timestamp: null, fields: new Map() };
  const get = (label) => fields.get(label);

  // The other party is the source on money received and the destination on money sent,
  // so your own account never shows up in the notification.
  const side = /^you sent/i.test(subject) ? "destination" : "source";
  const party = [
    get(`${side} acc. title`),
    get(`${side} bank`),
    get(`${side} acc. number`) ?? get("raast id / iban"),
  ]
    .filter(Boolean)
    .join(" · ");

  const lines = [`*${subject}*`, timestamp, party, get("transaction id")].filter(Boolean);

  if (lines.length === 1) {
    // Template changed or a non-transaction email: send readable body rather than nothing.
    const body = clean(email.text || stripTags(email.html || ""));
    if (body) lines.push(body.slice(0, 1500));
  }

  return lines.join("\n");
}

async function postWithRetry(env, text) {
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: text }),
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(env.NOTIFYBOT_URL, init);
      if (res.ok) return;
      console.error(`notifybot responded ${res.status} (attempt ${attempt})`, await res.text());
    } catch (err) {
      console.error(`notifybot unreachable (attempt ${attempt})`, err);
    }
    if (attempt < MAX_ATTEMPTS) await sleep(1000 * 2 ** (attempt - 1));
  }

  // Deliberately not throwing: a throw makes Cloudflare reject the message, which
  // bounces back to Gmail and can get the forwarding rule disabled.
  console.error("notification lost after retries:\n" + text);
}

function clean(s) {
  return decodeEntities(s).replace(/\s+/g, " ").trim();
}

function stripTags(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function decodeEntities(s) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return named[e.toLowerCase()] ?? m;
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));