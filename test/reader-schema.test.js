'use strict';

// Constrained decoding compiles the output schema into a grammar before the
// model generates anything, and that compilation has a budget. The header and
// the line items each fit inside it comfortably. Together they did not: the
// API spent three minutes on a real invoice and then refused with "Schema is
// too complex", and the manager was told to type it in by hand.
//
// Nothing here calls the API — these are structural rules that keep the two
// apart, so the next field added to a line item can't quietly re-create a
// schema that only fails once it meets a real invoice.

const test = require('node:test');
const assert = require('node:assert');
const { HEADER_SCHEMA, LINES_SCHEMA } = require('../src/reader');

/** Rough stand-in for what the grammar compiler has to chew through. */
function weigh(node) {
  if (!node || typeof node !== 'object') return 0;
  let n = 0;
  if (node.properties) for (const k of Object.keys(node.properties)) n += 1 + weigh(node.properties[k]);
  if (node.items) n += weigh(node.items);
  if (Array.isArray(node.enum)) n += node.enum.length;
  return n;
}

test('the header schema carries no line items', () => {
  assert.ok(HEADER_SCHEMA.properties.total, 'it is the accounting header');
  assert.strictEqual(HEADER_SCHEMA.properties.line_items, undefined,
    'merging line items back into the header is what broke invoice reading');
});

test('the line-item schema carries no header fields', () => {
  assert.ok(LINES_SCHEMA.properties.line_items, 'it is the item table');
  for (const headerOnly of ['vendor_name', 'total', 'tax', 'subtotal', 'category', 'confidence']) {
    assert.strictEqual(LINES_SCHEMA.properties[headerOnly], undefined,
      `${headerOnly} belongs to the header call`);
  }
});

test('each schema stays well inside what the compiler will accept', () => {
  // The combined schema weighed ~40 by this measure and was refused; each half
  // sits near half that. The budget is a tripwire, not a precise limit — if a
  // change pushes one over, that is the moment to split again rather than to
  // find out from a manager holding an invoice.
  const BUDGET = 30;
  assert.ok(weigh(HEADER_SCHEMA) < BUDGET, `header schema is getting heavy: ${weigh(HEADER_SCHEMA)}`);
  assert.ok(weigh(LINES_SCHEMA) < BUDGET, `line schema is getting heavy: ${weigh(LINES_SCHEMA)}`);
  assert.ok(weigh(HEADER_SCHEMA) + weigh(LINES_SCHEMA) > BUDGET,
    'together they exceed it — which is exactly why they are two calls');
});

test('both schemas are strict, which the API requires', () => {
  assert.strictEqual(HEADER_SCHEMA.additionalProperties, false);
  assert.strictEqual(LINES_SCHEMA.additionalProperties, false);
  assert.strictEqual(LINES_SCHEMA.properties.line_items.items.additionalProperties, false,
    'a nested object without this is rejected outright');
});

test('the line items still carry every signal matching depends on', () => {
  const p = LINES_SCHEMA.properties.line_items.items.properties;
  for (const field of ['description', 'code', 'brand', 'pack_size', 'qty', 'unit', 'total']) {
    assert.ok(p[field], `${field} is used to score a match — dropping it makes matching name-only`);
  }
});
