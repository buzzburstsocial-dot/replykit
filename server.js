import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import Stripe from 'stripe';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createHmac, createHash, randomBytes } from 'crypto';
import cookieParser from 'cookie-parser';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const COOKIE_SECRET = process.env.COOKIE_SECRET || (() => {
  const s = randomBytes(32).toString('hex');
  console.warn('\n  ⚠  COOKIE_SECRET not set — sessions will not survive restarts.\n');
  return s;
})();

app.use(express.json());
app.use(cookieParser());

// ── System prompt (prompt-cached) ──────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert reputation manager for local businesses. Your sole job is to write polished, thoughtful responses to Google reviews on behalf of business owners.

Rules:
- Keep responses between 75–150 words
- Always open by thanking the reviewer
- Address specific points raised in the review (mention them naturally)
- Never be defensive, dismissive, or argumentative
- Include a warm call-to-action when appropriate (invite them back, offer to discuss directly, etc.)
- If the reviewer's name appears in the review, use it once naturally; otherwise open with a generic greeting
- Sign off naturally as the business — do NOT write "[Business Name]" with brackets; just use "The Team" or "— The Team" if no real name is available
- Write in first person as the owner or their representative
- Output ONLY the response text — no preamble, no labels, no explanations`;

const TONE_GUIDE = {
  professional: 'Tone: Polished and formal. Be courteous, measured, and confident. Emphasize quality, consistency, and commitment to service excellence.',
  friendly:     'Tone: Warm and personable. Be genuine, upbeat, and conversational. Make the reviewer feel genuinely heard and appreciated.',
  apologetic:   'Tone: Empathetic and contrite. Sincerely acknowledge any shortcoming, take clear ownership, and emphasize concrete steps to make it right.',
};

// ── Rate limiting ───────────────────────────────────────────────────────────
const DAILY_LIMIT = 30;
const rateLimitStore = new Map();

function getRateLimitEntry(key) {
  const now = Date.now();
  let entry = rateLimitStore.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 24 * 60 * 60 * 1000 };
    rateLimitStore.set(key, entry);
  }
  return entry;
}

// ── Auth middleware ─────────────────────────────────────────────────────────
function isLocalhostRequest(req) {
  const ip = req.ip || req.connection.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function requireAuth(req, res, next) {
  // Localhost bypass for local development
  if (isLocalhostRequest(req)) {
    req.isLocalhost = true;
    req.sessionKey  = null;
    return next();
  }

  const token = req.cookies?.rk_session;
  if (!token) return res.redirect('/');
  try {
    const dot = token.lastIndexOf('.');
    if (dot === -1) throw new Error('malformed');
    const data = token.slice(0, dot);
    const sig  = token.slice(dot + 1);
    const expected = createHmac('sha256', COOKIE_SECRET).update(data).digest('base64url');
    if (sig !== expected) throw new Error('invalid signature');
    const { exp } = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (Date.now() > exp) throw new Error('expired');
    // Use a short hash of the cookie data as the rate-limit key (avoids storing PII)
    req.sessionKey  = createHash('sha256').update(data).digest('hex').slice(0, 16);
    req.isLocalhost = false;
    next();
  } catch {
    res.clearCookie('rk_session');
    res.redirect('/');
  }
}

// ── Pages ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) =>
  res.sendFile(join(__dirname, 'public', 'landing.html'))
);

app.get('/app', requireAuth, (req, res) =>
  res.sendFile(join(__dirname, 'public', 'app.html'))
);

// ── Stripe: create checkout session ─────────────────────────────────────────
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      subscription_data: { trial_period_days: 7 },
      success_url: `${req.protocol}://${req.get('host')}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${req.protocol}://${req.get('host')}/`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Stripe: post-payment redirect ────────────────────────────────────────────
app.get('/success', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.redirect('/');

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') return res.redirect('/');

    const email = session.customer_details?.email || '';
    const exp   = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const data  = Buffer.from(JSON.stringify({ email, exp })).toString('base64url');
    const sig   = createHmac('sha256', COOKIE_SECRET).update(data).digest('base64url');

    res.cookie('rk_session', `${data}.${sig}`, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      maxAge:   30 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
    });
    res.redirect('/app');
  } catch (err) {
    console.error('Stripe success handler error:', err);
    res.redirect('/');
  }
});

// ── Usage (remaining generations) ───────────────────────────────────────────
app.get('/api/usage', requireAuth, (req, res) => {
  if (req.isLocalhost) return res.json({ remaining: null, limit: DAILY_LIMIT });
  const entry = getRateLimitEntry(req.sessionKey);
  res.json({ remaining: Math.max(0, DAILY_LIMIT - entry.count), limit: DAILY_LIMIT });
});

// ── Generate (protected + rate-limited) ─────────────────────────────────────
app.post('/api/generate', requireAuth, async (req, res) => {
  const { review, tone, businessName } = req.body;

  if (!review?.trim()) {
    return res.status(400).json({ error: 'Review text is required.' });
  }
  if (!TONE_GUIDE[tone]) {
    return res.status(400).json({ error: 'Invalid tone. Choose professional, friendly, or apologetic.' });
  }

  // Rate limit check (skipped for localhost)
  let entry = null;
  if (!req.isLocalhost) {
    entry = getRateLimitEntry(req.sessionKey);
    if (entry.count >= DAILY_LIMIT) {
      return res.status(429).json({ error: `Daily limit of ${DAILY_LIMIT} generations reached. Resets in 24 hours.` });
    }
    entry.count++;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const biz = businessName?.trim() || null;
  const bizContext = biz
    ? `You are writing on behalf of "${biz}".`
    : 'You are writing on behalf of the business owner.';

  try {
    const stream = client.messages.stream({
      model: 'claude-opus-4-7',
      max_tokens: 512,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: `${bizContext}\n\n${TONE_GUIDE[tone]}\n\nGoogle Review:\n"${review.trim()}"`,
        },
      ],
    });

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }

    const remaining = req.isLocalhost ? null : Math.max(0, DAILY_LIMIT - entry.count);
    res.write(`data: ${JSON.stringify({ done: true, remaining, limit: DAILY_LIMIT })}\n\n`);
    res.end();
  } catch (err) {
    console.error('Anthropic API error:', err);
    // Roll back count on API error so failed requests don't consume quota
    if (entry) entry.count = Math.max(0, entry.count - 1);
    const message = err?.status === 401
      ? 'Invalid API key. Check your ANTHROPIC_API_KEY in .env.'
      : err?.message || 'Something went wrong. Please try again.';
    res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  ReplyKit → http://localhost:${PORT}\n`);
});
