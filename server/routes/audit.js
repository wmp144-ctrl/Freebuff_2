/**
 * NetWatch — API گزارش حسابرسی (فقط Administrator)
 */
import express from 'express';
import { listAudit } from '../audit.js';
import { requirePermission } from '../permissions.js';

const router = express.Router();

router.use(requirePermission('audit:read'));

router.get('/', (req, res) => {
  const result = listAudit({
    page: req.query.page,
    pageSize: req.query.pageSize,
    action: req.query.action,
    username: req.query.username,
    success: req.query.success,
    from: req.query.from,
    to: req.query.to,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json(result);
});

export default router;
