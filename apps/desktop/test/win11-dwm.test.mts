import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSolidWhiteBgraBuffer } from '../src/main/win11-dwm.ts';

test('buildSolidWhiteBgraBuffer returns pure opaque white (#FFFFFF) pixels with no logos or borders', () => {
  const width = 200;
  const height = 120;
  const buf = buildSolidWhiteBgraBuffer(width, height);

  assert.equal(buf.byteLength, width * height * 4);
  for (let i = 0; i < buf.byteLength; i += 4) {
    assert.equal(buf[i], 255, `blue channel at byte ${i} must be 255`);
    assert.equal(buf[i + 1], 255, `green channel at byte ${i + 1} must be 255`);
    assert.equal(buf[i + 2], 255, `red channel at byte ${i + 2} must be 255`);
    assert.equal(buf[i + 3], 255, `alpha channel at byte ${i + 3} must be 255`);
  }
});
