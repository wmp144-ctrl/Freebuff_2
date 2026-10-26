/**
 * فرم‌های ویرایش و ساخت گره/لینک توپولوژی
 * ----------------------------------------------------------------
 * • هر فرم فقط فیلدهای خودش را می‌فرستد؛ به‌روزرسانی‌ها جزئی‌اند و فیلدهای
 *   نامرتبط را بازنویسی نمی‌کنند.
 * • پیش‌نویس تا لحظهٔ ذخیره محلی است؛ والد با `onDirtyChange` از تغییرِ
 *   ذخیره‌نشده باخبر می‌شود و پیش از ترک انتخاب هشدار می‌دهد.
 * • دکمه‌ها هنگام ذخیره غیرفعال می‌شوند تا ارسال تکراری رخ ندهد.
 * • اعتبارسنجی سمت کلاینت فقط پیش‌بررسی است؛ پیام سرور همیشه نمایش داده می‌شود.
 */
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Link2, Plus, Save, Trash2 } from 'lucide-react';
import { Field, Modal, Spinner } from '../../components/ui';
import {
  KIND_META,
  LINK_STATE_META,
  MEDIA_META,
  MEDIUM_ORDER,
  connectionBodyFromDraft,
  connectionCreateError,
  connectionDraftFrom,
  nodeBodyFromDraft,
  nodeDraftFrom,
  parentCandidates,
  validateConnectionDraft,
  validateCreateNode,
  validateNodeDraft,
  type ConnectionDraft,
  type NodeDraft,
  type TopologyEdgeModel,
  type TopologyNodeKind,
  type TopologyNodeModel,
  type TransmissionMedium,
} from '../../lib/topology-hierarchy';
import type { DeviceStatus, HierarchyGroupRef } from '../../lib/types';
import { MediaSample } from './MediaLegend';

const NODE_KINDS: TopologyNodeKind[] = [
  'city',
  'aggregation',
  'station',
  'router',
  'switch',
  'firewall',
  'access-point',
  'server',
  'other',
];

const STATUS_OPTIONS: DeviceStatus[] = ['online', 'offline', 'warning', 'maintenance', 'unknown'];

function Banners({ error, dirty, saving }: { error: string; dirty: boolean; saving: boolean }) {
  return (
    <>
      {error ? (
        <p className="flex items-start gap-1.5 rounded-soft border border-red-200 bg-red-50 px-2.5 py-2 text-[10.5px] leading-5 text-red-700">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          {error}
        </p>
      ) : null}
      <p className="flex items-center gap-1.5 text-[10px] text-ink-400">
        {saving ? (
          <>
            <Spinner className="!h-3 !w-3" />
            در حال ذخیره…
          </>
        ) : dirty ? (
          <span className="text-sun-700">تغییرات ذخیره‌نشده</span>
        ) : (
          <span>همهٔ تغییرات ذخیره شده است.</span>
        )}
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* ویرایش گره                                                          */
/* ------------------------------------------------------------------ */

export function NodeEditForm({
  node,
  groups,
  saving,
  error,
  onSave,
  onDelete,
  onDirtyChange,
}: {
  node: TopologyNodeModel;
  groups: HierarchyGroupRef[];
  saving: boolean;
  error: string;
  onSave: (body: Record<string, unknown>) => Promise<boolean>;
  onDelete: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const initial = useMemo(() => nodeDraftFrom(node), [node]);
  const [draft, setDraft] = useState<NodeDraft>(initial);
  const [saved, setSaved] = useState<NodeDraft>(initial);
  const [showErrors, setShowErrors] = useState(false);
  const errors = validateNodeDraft(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const isDevice = node.kind !== 'city' && node.kind !== 'aggregation' && node.kind !== 'station';

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const set = <K extends keyof NodeDraft>(key: K, value: NodeDraft[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const submit = async () => {
    setShowErrors(true);
    if (Object.keys(errors).length) return;
    const ok = await onSave(nodeBodyFromDraft(draft));
    if (ok) {
      setSaved(draft);
      setShowErrors(false);
    }
  };

  return (
    <div className="space-y-2.5">
      <Banners error={error} dirty={dirty} saving={saving} />

      <Field label="نام" required error={showErrors ? errors.name : undefined}>
        <input className="field w-full" value={draft.name} onChange={(e) => set('name', e.target.value)} />
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="وضعیت">
          <select
            className="field w-full"
            value={draft.status}
            onChange={(e) => set('status', e.target.value as DeviceStatus)}
          >
            {STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>
                {status === 'online'
                  ? 'سالم'
                  : status === 'offline'
                    ? 'قطع'
                    : status === 'warning'
                      ? 'هشدار'
                      : status === 'maintenance'
                        ? 'تعمیرات'
                        : 'نامشخص'}
              </option>
            ))}
          </select>
        </Field>
        <Field label="گروه مالک" hint="مالکیت سازمانی، جدا از لینک‌ها">
          <select
            className="field w-full"
            value={draft.ownerGroupId}
            onChange={(e) => set('ownerGroupId', e.target.value)}
          >
            <option value="">بدون گروه</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="آدرس IP / نام میزبان" error={showErrors ? errors.ip : undefined}>
        <input
          className="field num w-full"
          dir="ltr"
          value={draft.ip}
          onChange={(e) => set('ip', e.target.value)}
          placeholder="10.0.0.1"
        />
      </Field>

      {isDevice ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field label="نوع تجهیز" error={showErrors ? errors.deviceType : undefined}>
              <input
                className="field w-full"
                value={draft.deviceType}
                onChange={(e) => set('deviceType', e.target.value)}
                placeholder="Router"
              />
            </Field>
            <Field label="تعداد پورت" error={showErrors ? errors.ports : undefined}>
              <input
                className="field num w-full"
                dir="ltr"
                inputMode="numeric"
                value={draft.ports}
                onChange={(e) => set('ports', e.target.value)}
                placeholder="48"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="سازنده" error={showErrors ? errors.vendor : undefined}>
              <input className="field w-full" value={draft.vendor} onChange={(e) => set('vendor', e.target.value)} />
            </Field>
            <Field label="مدل" error={showErrors ? errors.model : undefined}>
              <input className="field w-full" value={draft.model} onChange={(e) => set('model', e.target.value)} />
            </Field>
          </div>
        </>
      ) : null}

      <Field label="موقعیت" error={showErrors ? errors.location : undefined}>
        <input
          className="field w-full"
          value={draft.location}
          onChange={(e) => set('location', e.target.value)}
          placeholder="سالن، رک، طبقه"
        />
      </Field>

      <Field label="توضیح" error={showErrors ? errors.description : undefined}>
        <textarea
          className="field w-full"
          rows={2}
          value={draft.description}
          onChange={(e) => set('description', e.target.value)}
        />
      </Field>

      <Field label="یادداشت" error={showErrors ? errors.notes : undefined}>
        <textarea className="field w-full" rows={3} value={draft.notes} onChange={(e) => set('notes', e.target.value)} />
      </Field>

      <div className="flex items-center gap-1.5 pt-1">
        <button type="button" className="btn-primary btn-xs flex-1" onClick={() => void submit()} disabled={saving || !dirty}>
          {saving ? <Spinner className="!h-3.5 !w-3.5" /> : <Save size={13} />}
          ذخیرهٔ تغییرات
        </button>
        <button type="button" className="btn-danger btn-xs" onClick={onDelete} disabled={saving} title="حذف گره">
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ویرایش لینک                                                         */
/* ------------------------------------------------------------------ */

export function ConnectionEditForm({
  edge,
  nodes,
  saving,
  error,
  onSave,
  onDelete,
  onDirtyChange,
}: {
  edge: TopologyEdgeModel;
  nodes: TopologyNodeModel[];
  saving: boolean;
  error: string;
  onSave: (body: Record<string, unknown>) => Promise<boolean>;
  onDelete: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const initial = useMemo(() => connectionDraftFrom(edge), [edge]);
  const [draft, setDraft] = useState<ConnectionDraft>(initial);
  const [saved, setSaved] = useState<ConnectionDraft>(initial);
  const [showErrors, setShowErrors] = useState(false);
  const errors = validateConnectionDraft(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const set = <K extends keyof ConnectionDraft>(key: K, value: ConnectionDraft[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const submit = async () => {
    setShowErrors(true);
    if (Object.keys(errors).length) return;
    const ok = await onSave(connectionBodyFromDraft(draft));
    if (ok) {
      setSaved(draft);
      setShowErrors(false);
    }
  };

  return (
    <div className="space-y-2.5">
      <Banners error={error} dirty={dirty} saving={saving} />

      <div className="rounded-soft border border-ink-100 bg-ink-50/60 px-2.5 py-2 text-[11px] text-ink-600">
        <p className="truncate">{byId.get(edge.source)?.name ?? edge.source}</p>
        <p className="my-0.5 flex items-center gap-1 text-[10px] text-ink-400">
          <Link2 size={10} />
          <MediaSample medium={draft.medium} width={30} />
          <span className="ltr">→</span>
        </p>
        <p className="truncate">{byId.get(edge.target)?.name ?? edge.target}</p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="رسانهٔ انتقال">
          <select
            className="field w-full"
            value={draft.medium}
            onChange={(e) => set('medium', e.target.value as TransmissionMedium)}
          >
            {MEDIUM_ORDER.map((medium) => (
              <option key={medium} value={medium}>
                {MEDIA_META[medium].label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="وضعیت لینک">
          <select
            className="field w-full"
            value={draft.state}
            onChange={(e) => set('state', e.target.value as ConnectionDraft['state'])}
          >
            {(Object.keys(LINK_STATE_META) as ConnectionDraft['state'][]).map((state) => (
              <option key={state} value={state}>
                {LINK_STATE_META[state].label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="نقش" hint="اصلی یا پشتیبان">
          <select
            className="field w-full"
            value={draft.role}
            onChange={(e) => set('role', e.target.value as ConnectionDraft['role'])}
          >
            <option value="primary">اصلی</option>
            <option value="backup">پشتیبان</option>
          </select>
        </Field>
        <Field label="ظرفیت (مگابیت)" error={showErrors ? errors.capacityMbps : undefined}>
          <input
            className="field num w-full"
            dir="ltr"
            inputMode="decimal"
            value={draft.capacityMbps}
            onChange={(e) => set('capacityMbps', e.target.value)}
            placeholder="10000"
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="تأخیر (میلی‌ثانیه)" error={showErrors ? errors.latencyMs : undefined}>
          <input
            className="field num w-full"
            dir="ltr"
            inputMode="decimal"
            value={draft.latencyMs}
            onChange={(e) => set('latencyMs', e.target.value)}
          />
        </Field>
        <Field label="برچسب مدار" error={showErrors ? errors.label : undefined}>
          <input className="field w-full" value={draft.label} onChange={(e) => set('label', e.target.value)} />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="پورت مبدأ" error={showErrors ? errors.sourcePort : undefined}>
          <input
            className="field num w-full"
            dir="ltr"
            value={draft.sourcePort}
            onChange={(e) => set('sourcePort', e.target.value)}
            placeholder="xe-0/0/0"
          />
        </Field>
        <Field label="پورت مقصد" error={showErrors ? errors.targetPort : undefined}>
          <input
            className="field num w-full"
            dir="ltr"
            value={draft.targetPort}
            onChange={(e) => set('targetPort', e.target.value)}
            placeholder="xe-0/0/1"
          />
        </Field>
      </div>

      <Field label="توضیح" error={showErrors ? errors.description : undefined}>
        <textarea
          className="field w-full"
          rows={2}
          value={draft.description}
          onChange={(e) => set('description', e.target.value)}
        />
      </Field>

      <Field label="یادداشت" error={showErrors ? errors.notes : undefined}>
        <textarea className="field w-full" rows={3} value={draft.notes} onChange={(e) => set('notes', e.target.value)} />
      </Field>

      <div className="flex items-center gap-1.5 pt-1">
        <button type="button" className="btn-primary btn-xs flex-1" onClick={() => void submit()} disabled={saving || !dirty}>
          {saving ? <Spinner className="!h-3.5 !w-3.5" /> : <Save size={13} />}
          ذخیرهٔ تغییرات
        </button>
        <button type="button" className="btn-danger btn-xs" onClick={onDelete} disabled={saving} title="حذف لینک">
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ساخت گره                                                            */
/* ------------------------------------------------------------------ */

export function CreateNodeDialog({
  nodes,
  initialParentId,
  initialKind,
  saving,
  error,
  onClose,
  onCreate,
}: {
  nodes: TopologyNodeModel[];
  initialParentId?: string | null;
  initialKind?: TopologyNodeKind;
  saving: boolean;
  error: string;
  onClose: () => void;
  onCreate: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [kind, setKind] = useState<TopologyNodeKind>(initialKind ?? (initialParentId ? 'router' : 'city'));
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState(initialParentId ?? '');
  const [showErrors, setShowErrors] = useState(false);
  const errors = validateCreateNode(nodes, { kind, name, parentId });
  const parents = parentCandidates(nodes, kind);

  // با تغییر نوع، والد ناسازگار پاک می‌شود تا فرم به حالت نامعتبر نماند
  useEffect(() => {
    if (kind === 'city') setParentId('');
    else if (parentId && !parents.some((p) => p.id === parentId)) setParentId('');
  }, [kind, parentId, parents]);

  const submit = async () => {
    setShowErrors(true);
    if (Object.keys(errors).length) return;
    const ok = await onCreate({
      kind,
      name: name.trim(),
      ...(kind === 'city' ? {} : { parentId }),
    });
    if (ok) onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="افزودن گره به توپولوژی"
      subtitle="شهر، مرکز تجمع، ایستگاه یا تجهیز تازه — بدون بازنویسی داده‌های موجود"
      size="sm"
      footer={
        <>
          <button type="button" className="btn-ghost btn-xs" onClick={onClose} disabled={saving}>
            انصراف
          </button>
          <button type="button" className="btn-primary btn-xs" onClick={() => void submit()} disabled={saving}>
            {saving ? <Spinner className="!h-3.5 !w-3.5" /> : <Plus size={13} />}
            ایجاد گره
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? (
          <p className="rounded-soft border border-red-200 bg-red-50 px-2.5 py-2 text-[11px] text-red-700">{error}</p>
        ) : null}

        <Field label="نوع گره" required>
          <select className="field w-full" value={kind} onChange={(e) => setKind(e.target.value as TopologyNodeKind)}>
            {NODE_KINDS.map((item) => (
              <option key={item} value={item}>
                {KIND_META[item].label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="نام" required error={showErrors ? errors.name : undefined}>
          <input className="field w-full" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>

        {kind !== 'city' ? (
          <Field
            label={kind === 'aggregation' || kind === 'station' ? 'شهر' : 'مرکز تجمع / ایستگاه'}
            required
            error={showErrors ? errors.parentId : undefined}
            hint={parents.length === 0 ? 'ابتدا یک شهر یا مرکز/ایستگاه بسازید.' : undefined}
          >
            <select className="field w-full" value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">انتخاب کنید…</option>
              {parents.map((parent) => (
                <option key={parent.id} value={parent.id}>
                  {parent.name}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <p className="rounded-soft border border-dashed border-ink-200 bg-ink-50/60 px-2.5 py-2 text-[10.5px] leading-5 text-ink-500">
            شهر در بالاترین سطح قرار می‌گیرد؛ مرکز تجمع و ایستگاه زیر شهر و تجهیزات زیر مرکز/ایستگاه ساخته می‌شوند.
          </p>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* ساخت لینک                                                           */
/* ------------------------------------------------------------------ */

export function CreateConnectionDialog({
  nodes,
  edges,
  initialSourceId,
  saving,
  error,
  onClose,
  onCreate,
}: {
  nodes: TopologyNodeModel[];
  edges: TopologyEdgeModel[];
  initialSourceId?: string | null;
  saving: boolean;
  error: string;
  onClose: () => void;
  onCreate: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [sourceId, setSourceId] = useState(initialSourceId ?? '');
  const [targetId, setTargetId] = useState('');
  const [medium, setMedium] = useState<TransmissionMedium>('fiber');
  const [role, setRole] = useState<'primary' | 'backup'>('primary');
  const [capacityMbps, setCapacityMbps] = useState('');
  const [label, setLabel] = useState('');
  const [showErrors, setShowErrors] = useState(false);

  const draftErrors = validateConnectionDraft({
    medium,
    capacityMbps,
    latencyMs: '',
    sourcePort: '',
    targetPort: '',
    role,
    label,
    description: '',
    notes: '',
    state: 'up',
  });
  const relationError =
    showErrors || (sourceId && targetId)
      ? connectionCreateError(nodes, edges, sourceId, targetId, role)
      : null;

  const submit = async () => {
    setShowErrors(true);
    if (relationError || Object.keys(draftErrors).length) return;
    const ok = await onCreate({
      sourceId,
      targetId,
      medium,
      role,
      capacityMbps: capacityMbps.trim() === '' ? null : Number(capacityMbps),
      label: label.trim(),
    });
    if (ok) onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="افزودن لینک"
      subtitle="دو گره را انتخاب کنید؛ قواعد سطح شبکه پیش از ارسال بررسی می‌شود"
      size="sm"
      footer={
        <>
          <button type="button" className="btn-ghost btn-xs" onClick={onClose} disabled={saving}>
            انصراف
          </button>
          <button
            type="button"
            className="btn-primary btn-xs"
            onClick={() => void submit()}
            disabled={saving || Boolean(relationError)}
          >
            {saving ? <Spinner className="!h-3.5 !w-3.5" /> : <Link2 size={13} />}
            ایجاد لینک
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? (
          <p className="rounded-soft border border-red-200 bg-red-50 px-2.5 py-2 text-[11px] text-red-700">{error}</p>
        ) : null}

        <div className="grid grid-cols-2 gap-2">
          <Field label="مبدأ" required>
            <select className="field w-full" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              <option value="">انتخاب…</option>
              {nodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="مقصد" required>
            <select className="field w-full" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
              <option value="">انتخاب…</option>
              {nodes
                .filter((node) => node.id !== sourceId)
                .map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.name}
                  </option>
                ))}
            </select>
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field label="رسانهٔ انتقال">
            <select
              className="field w-full"
              value={medium}
              onChange={(e) => setMedium(e.target.value as TransmissionMedium)}
            >
              {MEDIUM_ORDER.map((item) => (
                <option key={item} value={item}>
                  {MEDIA_META[item].label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="نقش">
            <select
              className="field w-full"
              value={role}
              onChange={(e) => setRole(e.target.value as 'primary' | 'backup')}
            >
              <option value="primary">اصلی</option>
              <option value="backup">پشتیبان</option>
            </select>
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field label="ظرفیت (مگابیت)" error={showErrors ? draftErrors.capacityMbps : undefined}>
            <input
              className="field num w-full"
              dir="ltr"
              inputMode="decimal"
              value={capacityMbps}
              onChange={(e) => setCapacityMbps(e.target.value)}
              placeholder="1000"
            />
          </Field>
          <Field label="برچسب" error={showErrors ? draftErrors.label : undefined}>
            <input className="field w-full" value={label} onChange={(e) => setLabel(e.target.value)} />
          </Field>
        </div>

        {relationError ? (
          <p className="flex items-start gap-1.5 rounded-soft border border-sun-200 bg-sun-50 px-2.5 py-2 text-[10.5px] leading-5 text-sun-700">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            {relationError}
          </p>
        ) : null}

        <MediaSample medium={medium} width={120} />
      </div>
    </Modal>
  );
}
