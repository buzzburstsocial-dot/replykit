import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Stable system prompt — cached on first request, reused on subsequent ones
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

app.post('/api/generate', async (req, res) => {
  const { review, tone, businessName } = req.body;

  if (!review?.trim()) {
    return res.status(400).json({ error: 'Review text is required.' });
  }
  if (!TONE_GUIDE[tone]) {
    return res.status(400).json({ error: 'Invalid tone. Choose professional, friendly, or apologetic.' });
  }

  // Set up SSE
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
          cache_control: { type: 'ephemeral' }, // cached after first request
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

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('Anthropic API error:', err);
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
