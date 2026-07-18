'use strict';

// Photo-of-report reader. Sends one or more images of the end-of-day POS report
// to Claude's vision API and gets back structured per-server numbers. This is
// the "extract" half of extract-then-confirm — the manager reviews on the close
// screen before anything sends.

const Anthropic = require('@anthropic-ai/sdk');

// Default to the most capable model; override with READER_MODEL in .env if you
// want a cheaper/faster tier (e.g. claude-sonnet-5, claude-haiku-4-5).
const MODEL = process.env.READER_MODEL || 'claude-opus-4-8';

const SCHEMA = {
  type: 'object',
  properties: {
    servers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          food: { type: 'number' },
          coffee: { type: 'number' },
          alcohol: { type: 'number' },
          card_tips: { type: 'number' },
        },
        required: ['name', 'food', 'coffee', 'alcohol', 'card_tips'],
        additionalProperties: false,
      },
    },
    reported_total_tips: { type: 'number' },
  },
  required: ['servers'],
  additionalProperties: false,
};

const PROMPT =
  "These image(s) are an end-of-day sales report from a restaurant POS. For EACH server/employee listed, extract their food sales, coffee sales, alcohol sales, and CARD tips (not cash). " +
  'Return dollar amounts as plain numbers (e.g. 2100.5) — no "$" and no commas. If a category is not shown for someone, use 0. ' +
  'Only include real servers/employees — do NOT include category subtotals, section headers, or the grand total row as a "server". ' +
  'If the report shows a grand total of tips, put it in reported_total_tips. If several images are provided, they are pages of the same report — merge them into one list.';

/**
 * @param {Array<{buffer: Buffer, mimetype: string}>} files
 * @returns {Promise<{servers: Array, reported_total_tips?: number}>}
 */
async function readReport(files) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const e = new Error('No ANTHROPIC_API_KEY set — add one to .env to enable photo reading.');
    e.code = 'NO_KEY';
    throw e;
  }
  const client = new Anthropic();
  const images = files.map((f) => ({
    type: 'image',
    source: {
      type: 'base64',
      media_type: /png|webp|gif/.test(f.mimetype) ? f.mimetype : 'image/jpeg',
      data: f.buffer.toString('base64'),
    },
  }));

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: [...images, { type: 'text', text: PROMPT }] }],
  });

  const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const e = new Error('The model did not return readable numbers — try a clearer photo.');
    e.code = 'PARSE';
    throw e;
  }
  return data;
}

module.exports = { readReport, MODEL };
