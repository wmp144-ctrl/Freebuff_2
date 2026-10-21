/**
 * پنل بازرسی دیاگرام
 * ----------------------------------------------------------------
 * انتخاب گره/لینک را ویرایش می‌کند: یادداشت، برچسب، رنگ، اندازه، لایه، نوع
 * لینک و تنظیمات نمایش. وقتی چیزی انتخاب نشده باشد، تنظیمات دیاگرام و آمار
 * وضعیت نمایش داده می‌شود. همهٔ تغییرها از مسیر مشترک صفحه ذخیره می‌شوند تا
 * Undo/Redo و ذخیرهٔ خودکار یکسان بماند.
 */
import React from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  Building2,
  ExternalLink,
  Layers,
  Link2,
  MoveDown,
  MoveUp,
  Network,
  StickyNote,
  Trash2,
  X,
  CopyPlus,
  Palette,
  Settings2,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import type { TopoDiagram, TopoLink, TopoLinkKind, TopoNode, TopoSettings } from '../../lib/types';
import { LINK_META, LAYOUT_META, nodeMatches } from '../../lib/topology';
import { faDigits, fmtMs, statusMeta } from '../../lib/format';
import { Badge, Field, StatusPill, Toggle } from '../../components/ui';

const COLORS = ['', '#2563eb', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#64748b'];
const LINK_KINDS = Object.keys(LINK_META) as TopoLinkKind[];

interface Props {
  selectedNodes: TopoNode[];
  selectedLinks: TopoLink[];
  nodeById: Map<string, TopoNode>;
  diagram: TopoDiagram | null;
  readOnly: boolean;
  onClose: () => void;
  onChangeNode: (id: string, patch: Partial<TopoNode>) => void;
  onChangeLink: (id: string, patch: Partial<TopoLink>) => void;
  onDeleteSelection: () => void;
  onDuplicateSelection: () => void;
  onReorderNode: (id: string, action: 'front' | 'back') => void;
  onReverseLink: (id: string) => void;
  onDiagramChange: (patch: { name?: string; description?: string; settings?: TopoSettings; layout?: string }) => void;
  onManageSite: (siteId: number) => void;
}

function kindLabel(node: TopoNode): string {
  if (node.kind === 'device') return 'تجهیز شبکه';
  if (node.kind === 'site') return 'مرکز تجمع';
  if (node.kind === 'cloud') return 'شبکهٔ بیرونی';
  if (node.kind === 'note') return 'یادداشت';
  return 'گروه';
}

function NodeInspector({
  node,
  readOnly,
  onClose,
  onChangeNode,
  onDeleteSelection,
  onDuplicateSelection,
  onReorderNode,
  onManageSite,
}: {
  node: TopoNode;
  readOnly: boolean;
  onClose: () => void;
  onChangeNode: (id: string, patch: Partial<TopoNode>) => void;
  onDeleteSelection: () => void;
  onDuplicateSelection: () => void;
  onReorderNode: (id: string, action: 'front' | 'back') => void;
  onManageSite: (siteId: number) => void;
}) {
  const device = node.device;
  const status = device?.status || (node.kind === 'device' && !device ? 'removed' : 'unknown');
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start justify-between gap-2 border-b border-ink-100 p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[10.5px] text-ink-400">
            <Badge tone={node.kind === 'site' ? 'violet' : 'ink'}>{kindLabel(node)}</Badge>
            {node.kind === 'device' && device ? <StatusPill status={device.status} size="sm" /> : null}
            {status === 'removed' ? <Badge tone="red">مرجع حذف‌شده</Badge> : null}
          </div>
          <h3 className="mt-1.5 truncate text-sm font-semibold text-ink-800">
            {node.label || device?.name || node.site?.name || (node.kind === 'note' ? 'یادداشت' : 'گره')}
          </h3>
          {device ? <p className="num mt-0.5 text-[11px] text-ink-500">{device.ip}</p> : null}
        </div>
        <button type="button" className="btn-ghost btn-xs !px-2" onClick={onClose} aria-label="بستن پنل">
          <X size={14} />
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {device ? (
          <div className="rounded-soft border border-ink-100 bg-ink-50/50 p-3">
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
              <div>
                <dt className="text-ink-400">نوع</dt>
                <dd className="font-medium text-ink-700">{device.deviceType || '—'}</dd>
              </div>
              <div>
                <dt className="text-ink-400">گروه</dt>
                <dd className="truncate font-medium text-ink-700">{device.groupName || '—'}</dd>
              </div>
              <div>
                <dt className="text-ink-400">آخرین تأخیر</dt>
                <dd className="num font-medium text-ink-700">{fmtMs(device.lastRtt)}</dd>
              </div>
              <div>
                <dt className="text-ink-400">افت بسته</dt>
                <dd className="num font-medium text-ink-700">{faDigits(Number(device.lossPct || 0).toFixed(1))}٪</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-ink-400">محل استقرار</dt>
                <dd className="truncate font-medium text-ink-700">{device.location || '—'}</dd>
              </div>
            </dl>
            <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-ink-100 pt-2.5">
              <span className="text-[10.5px] text-ink-400">داده‌های زندهٔ مانیتورینگ</span>
              <Link to={`/devices/${device.id}`} className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-600 hover:text-brand-700">
                صفحهٔ تجهیز <ExternalLink size={11} />
              </Link>
            </div>
          </div>
        ) : null}

        {node.kind === 'site' ? (
          <div className="rounded-soft border border-indigo-100 bg-indigo-50/40 p-3">
            {node.site ? (
              <>
                <p className="text-[11.5px] font-medium text-indigo-800">{node.site.name}</p>
                <p className="mt-1 text-[10.5px] text-indigo-600">
                  {faDigits(node.site.deviceCount)} تجهیز · {faDigits(node.site.onlineCount)} در دسترس
                  {node.site.code ? ` · کد ${node.site.code}` : ''}
                </p>
                <button type="button" className="btn-ghost btn-xs mt-2" onClick={() => onManageSite(node.site!.id)}>
                  <Building2 size={12} /> مدیریت مرکز و تجهیزات
                </button>
              </>
            ) : (
              <p className="flex items-center gap-1.5 text-[11px] text-red-600">
                <AlertTriangle size={13} /> این مرکز تجمع از پایگاه‌داده حذف شده است.
              </p>
            )}
          </div>
        ) : null}

        <Field label="برچسب نمایش" hint={device ? `اگر خالی بماند، «${device.name}» نمایش داده می‌شود.` : undefined}>
          <input
            className="field text-[12.5px]"
            value={node.label}
            disabled={readOnly}
            maxLength={160}
            placeholder={device?.name || node.site?.name || 'برچسب گره'}
            onChange={(event) => onChangeNode(node.id, { label: event.target.value })}
          />
        </Field>

        <Field
          label={node.kind === 'note' ? 'متن یادداشت' : 'یادداشت گره'}
          hint={
            node.kind === 'note'
              ? 'این متن روی کارت یادداشت در بوم نمایش داده می‌شود.'
              : 'یادداشت مستقل از توضیحات خود تجهیز است و فقط در دیاگرام دیده می‌شود.'
          }
        >
          <textarea
            className="field min-h-[92px] resize-y text-[12px] leading-6"
            value={node.notes}
            disabled={readOnly}
            maxLength={4000}
            placeholder="توضیح، مسئول، شرایط خاص، تاریخ تغییر…"
            onChange={(event) => onChangeNode(node.id, { notes: event.target.value })}
          />
        </Field>

        <div>
          <p className="label flex items-center gap-1">
            <Palette size={12} /> رنگ لهجه
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {COLORS.map((color) => (
              <button
                key={color || 'none'}
                type="button"
                disabled={readOnly}
                onClick={() => onChangeNode(node.id, { color })}
                className={`grid h-6 w-6 place-items-center rounded-full border-2 transition ${
                  node.color === color ? 'border-ink-800 scale-110' : 'border-white'
                }`}
                style={{ background: color || '#f1f5f9' }}
                title={color || 'رنگ پیش‌فرض'}
                aria-label={color || 'رنگ پیش‌فرض'}
              >
                {!color ? <span className="text-[9px] text-ink-400">×</span> : null}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field label="عرض">
            <input
              type="number"
              className="field num text-[12px]"
              min={80}
              max={800}
              step={2}
              value={Math.round(node.width)}
              disabled={readOnly}
              onChange={(event) => onChangeNode(node.id, { width: Math.max(80, Math.min(800, Number(event.target.value) || 80)) })}
            />
          </Field>
          <Field label="ارتفاع">
            <input
              type="number"
              className="field num text-[12px]"
              min={40}
              max={600}
              step={2}
              value={Math.round(node.height)}
              disabled={readOnly}
              onChange={(event) => onChangeNode(node.id, { height: Math.max(40, Math.min(600, Number(event.target.value) || 40)) })}
            />
          </Field>
        </div>

        <div>
          <p className="label">ترتیب لایه</p>
          <div className="flex gap-1.5">
            <button type="button" className="btn-ghost btn-xs flex-1" disabled={readOnly} onClick={() => onReorderNode(node.id, 'front')}>
              <MoveUp size={12} /> جلو
            </button>
            <button type="button" className="btn-ghost btn-xs flex-1" disabled={readOnly} onClick={() => onReorderNode(node.id, 'back')}>
              <MoveDown size={12} /> عقب
            </button>
          </div>
        </div>
      </div>

      <footer className="flex items-center gap-2 border-t border-ink-100 p-3">
        <button type="button" className="btn-ghost btn-xs flex-1" disabled={readOnly} onClick={onDuplicateSelection}>
          <CopyPlus size={13} /> تکثیر
        </button>
        <button type="button" className="btn-danger btn-xs flex-1" disabled={readOnly} onClick={onDeleteSelection}>
          <Trash2 size={13} /> حذف
        </button>
      </footer>
    </div>
  );
}

function LinkInspector({
  link,
  nodeById,
  readOnly,
  onClose,
  onChangeLink,
  onDeleteSelection,
  onReverseLink,
}: {
  link: TopoLink;
  nodeById: Map<string, TopoNode>;
  readOnly: boolean;
  onClose: () => void;
  onChangeLink: (id: string, patch: Partial<TopoLink>) => void;
  onDeleteSelection: () => void;
  onReverseLink: (id: string) => void;
}) {
  const from = nodeById.get(link.from);
  const to = nodeById.get(link.to);
  const fromLabel = from ? from.label || from.device?.name || from.site?.name || 'گره' : 'گرهٔ حذف‌شده';
  const toLabel = to ? to.label || to.device?.name || to.site?.name || 'گره' : 'گرهٔ حذف‌شده';
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start justify-between gap-2 border-b border-ink-100 p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[10.5px] text-ink-400">
            <Badge tone="brand">
              <Link2 size={10} /> لینک ارتباطی
            </Badge>
            <span>{LINK_META[link.kind]?.label}</span>
          </div>
          <h3 className="mt-1.5 truncate text-sm font-semibold text-ink-800">{link.label || `${fromLabel} ↔ ${toLabel}`}</h3>
        </div>
        <button type="button" className="btn-ghost btn-xs !px-2" onClick={onClose} aria-label="بستن پنل">
          <X size={14} />
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div className="rounded-soft border border-ink-100 bg-ink-50/50 p-3 text-[11px]">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-medium text-ink-700" title={fromLabel}>
              {fromLabel}
            </span>
            <button
              type="button"
              className="btn-ghost btn-xs !px-1.5"
              onClick={() => onReverseLink(link.id)}
              disabled={readOnly}
              title="جابه‌جایی جهت لینک"
              aria-label="جابه‌جایی جهت لینک"
            >
              <ArrowLeftRight size={12} />
            </button>
            <span className="min-w-0 flex-1 truncate text-left font-medium text-ink-700" title={toLabel}>
              {toLabel}
            </span>
          </div>
        </div>

        <Field label="برچسب لینک" hint="مثلاً «فیبر ۱۰G»، «Backup» یا پهنای باند">
          <input
            className="field text-[12.5px]"
            value={link.label}
            disabled={readOnly}
            maxLength={160}
            onChange={(event) => onChangeLink(link.id, { label: event.target.value })}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="نوع ارتباط">
            <select
              className="field text-[12px]"
              value={link.kind}
              disabled={readOnly}
              onChange={(event) => onChangeLink(link.id, { kind: event.target.value as TopoLinkKind })}
            >
              {LINK_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {LINK_META[kind].label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="سبک خط">
            <select
              className="field text-[12px]"
              value={link.style}
              disabled={readOnly}
              onChange={(event) => onChangeLink(link.id, { style: event.target.value as TopoLink['style'] })}
            >
              <option value="solid">پیوسته</option>
              <option value="dashed">خط‌چین</option>
              <option value="dotted">نقطه‌چین</option>
            </select>
          </Field>
        </div>

        <Field label="یادداشت ارتباط" hint="مسیر، ظرفیت، ISP، شمارهٔ قرارداد…">
          <textarea
            className="field min-h-[86px] resize-y text-[12px] leading-6"
            value={link.notes}
            disabled={readOnly}
            maxLength={4000}
            onChange={(event) => onChangeLink(link.id, { notes: event.target.value })}
          />
        </Field>

        <div>
          <p className="label">رنگ لینک</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {COLORS.map((color) => (
              <button
                key={color || 'none'}
                type="button"
                disabled={readOnly}
                onClick={() => onChangeLink(link.id, { color })}
                className={`grid h-6 w-6 place-items-center rounded-full border-2 transition ${
                  link.color === color ? 'border-ink-800 scale-110' : 'border-white'
                }`}
                style={{ background: color || LINK_META[link.kind]?.color || '#cbd5e1' }}
                title={color || 'رنگ نوع لینک'}
                aria-label={color || 'رنگ نوع لینک'}
              >
                {!color ? <span className="text-[9px] text-white/90">×</span> : null}
              </button>
            ))}
          </div>
        </div>
      </div>

      <footer className="flex items-center gap-2 border-t border-ink-100 p-3">
        <button type="button" className="btn-danger btn-xs w-full" disabled={readOnly} onClick={onDeleteSelection}>
          <Trash2 size={13} /> حذف لینک
        </button>
      </footer>
    </div>
  );
}

function DiagramInspector({
  diagram,
  readOnly,
  onDiagramChange,
  onClose,
}: {
  diagram: TopoDiagram;
  readOnly: boolean;
  onDiagramChange: (patch: { name?: string; description?: string; settings?: TopoSettings; layout?: string }) => void;
  onClose: () => void;
}) {
  const settings = {
    showLabels: true,
    showIps: true,
    showNotes: false,
    showGrid: true,
    snapToGrid: false,
    gridSize: 20,
    edgeStyle: 'bezier' as const,
    ...(diagram.settings || {}),
  };
  const patch = (next: Partial<TopoSettings>) => onDiagramChange({ settings: { ...settings, ...next } });
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start justify-between gap-2 border-b border-ink-100 p-4">
        <div className="min-w-0">
          <p className="text-[10.5px] text-ink-400">تنظیمات دیاگرام</p>
          <h3 className="mt-1 truncate text-sm font-semibold text-ink-800">{diagram.name}</h3>
        </div>
        <button type="button" className="btn-ghost btn-xs !px-2" onClick={onClose} aria-label="بستن پنل">
          <X size={14} />
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div className="grid grid-cols-3 gap-2 text-center">
          {[
            ['گره', diagram.nodes.length],
            ['لینک', diagram.links.length],
            ['تجهیز', diagram.deviceCount],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-soft border border-ink-100 bg-white p-2">
              <p className="num text-base font-bold text-ink-800">{faDigits(Number(value))}</p>
              <p className="text-[10px] text-ink-400">{label}</p>
            </div>
          ))}
        </div>

        <Field label="نام دیاگرام">
          <input
            className="field text-[12.5px]"
            value={diagram.name}
            disabled={readOnly}
            maxLength={120}
            onChange={(event) => onDiagramChange({ name: event.target.value })}
          />
        </Field>
        <Field label="توضیحات">
          <textarea
            className="field min-h-[64px] text-[12px]"
            value={diagram.description}
            disabled={readOnly}
            maxLength={500}
            onChange={(event) => onDiagramChange({ description: event.target.value })}
          />
        </Field>

        <div className="space-y-2.5 rounded-soft border border-ink-100 bg-ink-50/40 p-3">
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-ink-600">
            <Settings2 size={12} /> نمایش
          </p>
          <Toggle checked={!!settings.showLabels} disabled={readOnly} onChange={(v) => patch({ showLabels: v })} label="برچسب نام" />
          <Toggle checked={!!settings.showIps} disabled={readOnly} onChange={(v) => patch({ showIps: v })} label="آدرس IP" />
          <Toggle checked={!!settings.showNotes} disabled={readOnly} onChange={(v) => patch({ showNotes: v })} label="نمایش یادداشت‌ها" />
          <Toggle checked={!!settings.showGrid} disabled={readOnly} onChange={(v) => patch({ showGrid: v })} label="شبکهٔ نقطه‌ای" />
          <Toggle
            checked={!!settings.snapToGrid}
            disabled={readOnly}
            onChange={(v) => patch({ snapToGrid: v, gridSize: settings.gridSize || 20 })}
            label="چسبیدن به شبکه"
            hint="جابه‌جایی گره‌ها در گام‌های منظم"
          />
          <div className="grid grid-cols-2 gap-2 pt-1">
            <Field label="سبک لینک">
              <select
                className="field !py-1.5 text-[11.5px]"
                value={settings.edgeStyle}
                disabled={readOnly}
                onChange={(event) => patch({ edgeStyle: event.target.value as 'bezier' | 'orthogonal' })}
              >
                <option value="bezier">منحنی</option>
                <option value="orthogonal">شکسته</option>
              </select>
            </Field>
            <Field label="گام شبکه">
              <input
                type="number"
                className="field num !py-1.5 text-[11.5px]"
                min={8}
                max={80}
                step={2}
                value={settings.gridSize}
                disabled={readOnly}
                onChange={(event) => patch({ gridSize: Math.max(8, Math.min(80, Number(event.target.value) || 20)) })}
              />
            </Field>
          </div>
        </div>

        <Field label="چیدمان پیش‌فرض">
          <select
            className="field text-[12px]"
            value={diagram.layout}
            disabled={readOnly}
            onChange={(event) => onDiagramChange({ layout: event.target.value })}
          >
            {Object.entries(LAYOUT_META).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>

        <div className="rounded-soft border border-ink-100 bg-white p-3">
          <p className="mb-2 text-[11px] font-medium text-ink-600">وضعیت تجهیزات</p>
          <div className="flex flex-wrap gap-1.5">
            <StatusPill status="online" size="sm" showLabel pulse={false} />
            <span className="num text-[10.5px] text-ink-500">{faDigits(diagram.stats.online)}</span>
            <StatusPill status="warning" size="sm" showLabel pulse={false} />
            <span className="num text-[10.5px] text-ink-500">{faDigits(diagram.stats.warning)}</span>
            <StatusPill status="offline" size="sm" showLabel={false} />
            <span className="num text-[10.5px] text-ink-500">{faDigits(diagram.stats.offline)}</span>
            <StatusPill status="unknown" size="sm" showLabel={false} />
            <span className="num text-[10.5px] text-ink-500">{faDigits(diagram.stats.unknown)}</span>
          </div>
        </div>

        <p className="text-[10.5px] leading-5 text-ink-400">
          برای ویرایش یک گره یا لینک، روی آن کلیک کنید. برای انتخاب چندگانه Shift را نگه دارید.
        </p>
      </div>
    </div>
  );
}

export default function Inspector(props: Props) {
  const { selectedNodes, selectedLinks, nodeById, diagram, readOnly, onClose } = props;
  let content: React.ReactNode;
  if (selectedNodes.length === 1 && selectedLinks.length === 0) {
    content = (
      <NodeInspector
        node={selectedNodes[0]}
        readOnly={readOnly}
        onClose={onClose}
        onChangeNode={props.onChangeNode}
        onDeleteSelection={props.onDeleteSelection}
        onDuplicateSelection={props.onDuplicateSelection}
        onReorderNode={props.onReorderNode}
        onManageSite={props.onManageSite}
      />
    );
  } else if (selectedLinks.length === 1 && selectedNodes.length === 0) {
    content = (
      <LinkInspector
        link={selectedLinks[0]}
        nodeById={nodeById}
        readOnly={readOnly}
        onClose={onClose}
        onChangeLink={props.onChangeLink}
        onDeleteSelection={props.onDeleteSelection}
        onReverseLink={props.onReverseLink}
      />
    );
  } else if (selectedNodes.length > 1 || selectedLinks.length > 1) {
    content = (
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between border-b border-ink-100 p-4">
          <div>
            <p className="text-[10.5px] text-ink-400">انتخاب چندگانه</p>
            <h3 className="text-sm font-semibold text-ink-800">
              {faDigits(selectedNodes.length)} گره و {faDigits(selectedLinks.length)} لینک
            </h3>
          </div>
          <button type="button" className="btn-ghost btn-xs !px-2" onClick={onClose} aria-label="بستن پنل">
            <X size={14} />
          </button>
        </header>
        <div className="flex-1 space-y-2 overflow-y-auto p-4">
          {selectedNodes.map((n) => (
            <div key={n.id} className="flex items-center gap-2 rounded-soft border border-ink-100 px-2.5 py-2 text-[11.5px]">
              {n.kind === 'site' ? <Building2 size={13} className="text-indigo-500" /> : n.kind === 'note' ? <StickyNote size={13} className="text-amber-500" /> : <Network size={13} className="text-brand-500" />}
              <span className="min-w-0 flex-1 truncate text-ink-700">{n.label || n.device?.name || n.site?.name || 'گره'}</span>
              {n.device ? <span className="num text-[10px] text-ink-400">{n.device.ip}</span> : null}
            </div>
          ))}
        </div>
        <footer className="flex gap-2 border-t border-ink-100 p-3">
          <button type="button" className="btn-ghost btn-xs flex-1" disabled={readOnly} onClick={props.onDuplicateSelection}>
            <CopyPlus size={13} /> تکثیر
          </button>
          <button type="button" className="btn-danger btn-xs flex-1" disabled={readOnly} onClick={props.onDeleteSelection}>
            <Trash2 size={13} /> حذف
          </button>
        </footer>
      </div>
    );
  } else if (diagram) {
    content = (
      <DiagramInspector
        diagram={diagram}
        readOnly={readOnly}
        onDiagramChange={props.onDiagramChange}
        onClose={onClose}
      />
    );
  } else {
    content = null;
  }

  if (!content) return null;
  return (
    <div className="absolute inset-y-3 left-3 z-30 flex w-[min(320px,calc(100%-1.5rem))] flex-col overflow-hidden rounded-card border border-white/80 bg-white/97 shadow-pop backdrop-blur-xl">
      {content}
    </div>
  );
}

export { Inspector };
