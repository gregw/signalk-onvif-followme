'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {makeIconSvg} = require('../tools/make-icon');

test('public/icon.svg is what tools/make-icon.js generates', () => {
    const committed = fs.readFileSync(path.join(__dirname, '..', 'public', 'icon.svg'), 'utf8');
    assert.equal(makeIconSvg(), committed);
});
