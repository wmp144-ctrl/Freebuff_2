/**
 * ارتفاع دلخواه ویجت‌ها (heightPx) در تنظیمات چیدمان.
 *
 * ارتفاع با کشیدن لبهٔ پایین ویجت تنظیم می‌شود؛ سرور باید مقدار پیکسلی را
 * حفظ و مرزگذاری کند و همچنان با چیدمان‌های قدیمی که فقط height دارند کار کند.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupDir } from '../helpers.mjs';

const dir = useTempDataDir('widget-layout');
const { db, sanitizeSettings } = await import('../../db.js');

test.after(() => {
  db.close();
  cleanupDir(dir);
});

test('ارتفاع پیکسلی دلخواه حفظ و گرد می‌شود', () => {
  const { clean } = sanitizeSettings({
    dashboard_widgets: [{ id: 'health', size: 'md', height: 'sm', heightPx: 337.6, visible: true }],
  });
  assert.equal(clean.dashboard_widgets[0].heightPx, 338);
  assert.equal(clean.dashboard_widgets[0].height, 'sm', 'سطح قدیمی برای سازگاری می‌ماند');
});

test('ارتفاع پیکسلی به بازهٔ مجاز مرزگذاری می‌شود', () => {
  const { clean } = sanitizeSettings({
    dashboard_widgets: [
      { id: 'too-small', heightPx: 10 },
      { id: 'too-large', heightPx: 99999 },
    ],
  });
  assert.equal(clean.dashboard_widgets[0].heightPx, 180);
  assert.equal(clean.dashboard_widgets[1].heightPx, 1400);
});

test('چیدمان قدیمی بدون heightPx معتبر می‌ماند', () => {
  const { clean } = sanitizeSettings({
    device_detail_widgets: [{ id: 'general', size: 'sm', height: 'lg' }],
  });
  assert.equal(clean.device_detail_widgets[0].height, 'lg');
  assert.equal('heightPx' in clean.device_detail_widgets[0], false);
});

test('heightPx نامعتبر ذخیره نمی‌شود و شناسه/اندازهٔ نامعتبر مرزگذاری می‌شود', () => {
  const { clean } = sanitizeSettings({
    dashboard_widgets: [{ id: ' chart ', size: 'huge', heightPx: 'not-a-number' }],
  });
  const widget = clean.dashboard_widgets[0];
  assert.equal(widget.id, 'chart');
  assert.equal(widget.size, 'md');
  assert.equal('heightPx' in widget, false);
});
