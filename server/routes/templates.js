/**
 * NetWatch — API قالب تجهیزات
 */
import express from 'express';
import { db } from '../db.js';
import { routePermission } from '../permissions.js';
import {
  TEMPLATE_FIELDS,
  fieldLabel,
  serializeTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  applyTemplate,
} from '../management.js';

const router = express.Router();

router.use(routePermission({ read: 'devices:read', write: 'devices:write' }));

router.get('/', (_req, res) => {
  res.json({
    items: db
      .prepare(
        `SELECT t.*, (SELECT COUNT(*) FROM devices d WHERE d.device_type = t.device_type AND t.device_type != '') AS device_count
         FROM device_templates t ORDER BY t.name`
      )
      .all()
      .map(serializeTemplate),
    fields: TEMPLATE_FIELDS.map((key) => ({ key, label: fieldLabel(key) })),
  });
});

router.post('/', (req, res) => {
  try {
    const item = createTemplate(req.body || {}, { actor: req.user?.username || '' });
    res.status(201).json(item);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const item = updateTemplate(req.params.id, req.body || {}, { actor: req.user?.username || '' });
    if (!item) return res.status(404).json({ error: 'قالب یافت نشد' });
    return res.json(item);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', (req, res) => {
  const n = deleteTemplate(req.params.id);
  if (!n) return res.status(404).json({ error: 'قالب یافت نشد' });
  res.json({ deleted: n });
});

/**
 * اعمال قالب. `overwrite: false` (پیش‌فرض) فقط فیلدهای خالی را پر می‌کند و
 * تنظیمات اختصاصی تجهیز را دست نمی‌زند؛ برای بازنویسی، تأیید صریح لازم است.
 */
router.post('/:id/apply', (req, res) => {
  try {
    const { deviceIds, fields, overwrite } = req.body || {};
    const result = applyTemplate(req.params.id, {
      deviceIds: Array.isArray(deviceIds) ? deviceIds : [],
      fields: Array.isArray(fields) ? fields : null,
      overwrite: overwrite === true,
    });
    res.json({ ...result, overwrite: overwrite === true });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

export default router;
