'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Heizwarte = require('./_load.js');

test('_load.js liefert globalThis.Heizwarte mit allen Modulnamen', () => {
  const namen = ['storage', 'i18n', 'geo', 'weather', 'heat', 'chart'];

  assert.equal(Heizwarte, globalThis.Heizwarte);
  assert.deepEqual(Object.keys(Heizwarte).sort(), namen.slice().sort());
  for (const name of namen) {
    assert.equal(typeof Heizwarte[name], 'object', name + ' fehlt oder ist kein Objekt');
  }
  assert.deepEqual(Heizwarte._missing, []);
});
