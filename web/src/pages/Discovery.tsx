import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, Clock, Edit3, Plus, Radar, RefreshCw, ScanLine, Search, Server, Trash2, X } from 'lucide-react';
import { api } from '../lib/api';
import { useApp, useAsync, useToast } from '../lib/store';
import { useAuth } from '../lib/auth';
import { faDigits, fmtDateTime, fmtRelative } from '../lib/format';
import { Badge, Card, CardHeader, EmptyState, ErrorState, Field, Modal, PageLoader, Toggle } from '../components/ui';
import type { Device, DiscoveryRange, DiscoveryResult } from '../lib/types';

interface RangeForm {
  name: string;
  cidr: string;
  intervalHours: string;
  notes: string;
  enabled: boolean;
}

const emptyForm: RangeForm = { name: '', cidr: '', intervalHours: '24', notes: '', enabled: true };

function remainingLabel(expiresAt: number, now: number) {
  const ms = expiresAt - now;
  if (ms <= 0) return 'منقضی';
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${faDigits(hours)} ساعت و ${faDigits(minutes)} دقیقه`;
  return `${faDigits(minutes)} دقیقه`;
}

export default function Discovery() {
  const { push } = useToast();
  const { refreshMeta } = useApp();
  const { can } = useAuth();
  const canWrite = can('devices:write');
  const canScan = can('probe:run');

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<DiscoveryRange | null>(null);
  const [form, setForm] = useState<RangeForm>(emptyForm);
  const [selectedRanges, setSelectedRanges] = useState<number[]>([]);
  const [scanning, setScanning] = useState(false);
  const [search, setSearch] = useState('');
  const [now, setNow] = useState(Date.now());

  const { data, loading, error, refresh, refreshing, updatedAt } = useAsync((signal) => api.discovery(signal), [], { interval: 30000 });
  const results = useAsync((signal) => api.discoveryResults({ limit: 200 }, signal), [], { interval: 15000 });

  const ranges = data?.items ?? [];
  const discovered = results.data?.items ?? [];
  const scan = data?.discovery.scan;
  const running = !!scan?.running;
  const limits = data?.limits;

  // شمارندهٔ انقضای ۲۴ ساعته در UI (بدون درخواست اضافه)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);

  // پایان اسکن → بازخوانی نتایج و اعلان
  const wasRunning = React.useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) {
      refresh();
      results.refresh();
      if (scan?.added) push(`${faDigits(scan.added)} تجهیز جدید کشف شد`, 'success');
      else if (scan?.found != null) push('اسکن پایان یافت؛ تجهیز جدیدی ثبت نشد', 'info');
    }
    wasRunning.current = running;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setFormOpen(true);
  };

  const openEdit = (range: DiscoveryRange) => {
    setEditing(range);
    setForm({
      name: range.name,
      cidr: range.cidr,
      intervalHours: String(range.intervalHours),
      notes: range.notes,
      enabled: range.enabled,
    });
    setFormOpen(true);
  };

  const save = async () => {
    if (!form.name.trim() || !form.cidr.trim()) return push('نام و محدودهٔ CIDR الزامی است', 'error');
    try {
      const payload = {
        name: form.name.trim(),
        cidr: form.cidr.trim(),
        intervalHours: Number(form.intervalHours) || 24,
        notes: form.notes.trim(),
        enabled: form.enabled ? 1 : 0,
      };
      if (editing) await api.updateDiscoveryRange(editing.id, payload);
      else await api.createDiscoveryRange(payload);
      push(editing ? 'محدوده به‌روزرسانی شد' : 'محدودهٔ جدید افزوده شد', 'success');
      setFormOpen(false);
      refresh();
    } catch (e) {
      push((e as Error).message, 'error');
    }
  };

  const remove = async (range: DiscoveryRange) => {
    if (!window.confirm(`محدوده «${range.name}» حذف شود؟ تجهیزات کشف‌شدهٔ قبلی حذف نمی‌شوند.`)) return;
    try {
      await api.deleteDiscoveryRange(range.id);
      push('محدوده حذف شد', 'success');
      refresh();
    } catch (e) {
      push((e as Error).message, 'error');
    }
  };

  const startScan = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      const ids = selectedRanges.length ? selectedRanges : undefined;
      await api.scanDiscovery(ids);
      push('اسکن در پس‌زمینه آغاز شد', 'info');
      refresh();
      results.refresh();
    } catch (e) {
      push((e as Error).message, 'error');
    } finally {
      setScanning(false);
    }
  };

  const importResult = async (row: DiscoveryResult) => {
    const name = window.prompt('نام تجهیز برای ثبت در سامانه:', `تجهیز کشف‌شده ${row.ip}`);
    if (name === null) return;
    try {
      await api.importDiscovered(row.id, name);
      push('تجهیز در سامانه ثبت شد', 'success');
      refreshMeta();
      results.refresh();
    } catch (e) {
      push((e as Error).message, 'error');
    }
  };

  const dismiss = async (row: DiscoveryResult) => {
    if (!window.confirm(`میزبان ${row.ip} از فهرست کشف‌شده‌ها حذف شود؟ (تجهیز ثبت‌شده حذف نمی‌شود)`)) return;
    try {
      await api.dismissDiscovered(row.id);
      results.refresh();
    } catch (e) {
      push((e as Error).message, 'error');
    }
  };

  const filteredResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? discovered.filter((d) => d.ip.includes(q) || (d.rangeName || '').toLowerCase().includes(q)) : discovered;
  }, [discovered, search]);

  if (loading && !data) return <PageLoader label="در حال دریافت محدوده‌های کشف…" />;
  if (error && !data) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <div className="space-y-4">
      <Card padded={false} className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-soft border border-brand-100 bg-brand-50 text-brand-600">
              <Radar size={18} />
            </span>
            <div>
              <p className="text-[13px] font-semibold text-ink-800">کشف خودکار شبکه</p>
              <p className="text-[10.5px] text-ink-400">
                اسکن دوره‌ای هر {faDigits(limits?.intervalHours ?? 24)} ساعت · حداکثر {faDigits(limits?.maxHosts ?? 256)} میزبان در هر محدوده
              </p>
            </div>
          </div>
          <div className="ms-auto flex flex-wrap items-center gap-2">
            <button type="button" className="btn-ghost btn-xs" onClick={() => { refresh(); results.refresh(); }} disabled={refreshing || results.refreshing}>
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
              بروزرسانی
            </button>
            {canWrite ? (
              <button type="button" className="btn-soft btn-xs" onClick={openCreate}>
                <Plus size={14} />
                محدودهٔ جدید
              </button>
            ) : null}
            {canScan ? (
              <button type="button" className="btn-primary btn-xs" onClick={startScan} disabled={running || scanning}>
                <ScanLine size={14} />
                {running ? 'در حال اسکن…' : 'اسکن فوری'}
              </button>
            ) : null}
          </div>
        </div>
        {running ? (
          <div className="mt-3 flex items-center gap-2 rounded-soft border border-brand-100 bg-brand-50/60 px-3 py-2 text-[11px] text-brand-800">
            <RefreshCw size={13} className="animate-spin" />
            اسکن در جریان است — {faDigits(scan?.found ?? 0)} میزبان پاسخ‌دهنده، {faDigits(scan?.added ?? 0)} تجهیز جدید.
          </div>
        ) : scan?.error ? (
          <div className="mt-3 rounded-soft border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700">آخرین اسکن: {scan.error}</div>
        ) : null}
        <p className="mt-3 text-[10.5px] leading-relaxed text-ink-400">
          فقط محدوده‌های زیرمجموعهٔ شبکه‌های مجاز Probe اسکن می‌شوند. نتایج تازه تا {faDigits(limits?.retainHours ?? 24)} ساعت با نشان «تازه» می‌مانند و سپس فقط از همین فهرست حذف می‌شوند؛ تجهیز ثبت‌شده در سامانه دست‌نخورده است.
        </p>
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card padded={false} className="p-4">
          <CardHeader
            title="محدوده‌های ذخیره‌شده"
            subtitle={`${faDigits(ranges.length)} محدوده · ${faDigits(ranges.filter((r) => r.enabled).length)} فعال`}
            icon={<Radar size={18} />}
            action={
              ranges.length ? (
                <button
                  type="button"
                  className="btn-ghost btn-xs"
                  onClick={() => setSelectedRanges(selectedRanges.length === ranges.length ? [] : ranges.map((r) => r.id))}
                >
                  {selectedRanges.length === ranges.length ? 'لغو انتخاب' : 'انتخاب همه'}
                </button>
              ) : null
            }
          />
          <div className="mt-4 space-y-2">
            {ranges.length === 0 ? (
              <EmptyState title="هنوز محدوده‌ای تعریف نشده" description="با دکمهٔ «محدودهٔ جدید» یک زیرشبکهٔ داخلی اضافه کنید." />
            ) : (
              ranges.map((range) => (
                <div key={range.id} className={`rounded-soft border p-3 transition ${selectedRanges.includes(range.id) ? 'border-brand-300 bg-brand-50/40' : 'border-ink-200 bg-white/70'}`}>
                  <div className="flex items-start gap-2">
                    {canScan ? (
                      <input
                        type="checkbox"
                        className="mt-1 accent-brand-600"
                        checked={selectedRanges.includes(range.id)}
                        onChange={(e) =>
                          setSelectedRanges((s) => (e.target.checked ? [...s, range.id] : s.filter((x) => x !== range.id)))
                        }
                        aria-label={`انتخاب ${range.name}`}
                      />
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-[12.5px] font-semibold text-ink-800">{range.name}</p>
                        <Badge tone={range.enabled ? 'emerald' : 'ink'}>{range.enabled ? 'فعال' : 'غیرفعال'}</Badge>
                        <span className="num rounded bg-ink-100 px-1.5 py-0.5 text-[10px] text-ink-600" dir="ltr">
                          {range.cidr}
                        </span>
                      </div>
                      <p className="mt-1 text-[10.5px] text-ink-400">
                        {faDigits(range.hosts)} آدرس · هر {faDigits(range.intervalHours)} ساعت · آخرین اسکن:{' '}
                        {range.lastScanAt ? fmtDateTime(range.lastScanAt, 210) : 'هرگز'}
                      </p>
                      {range.lastScanMessage ? <p className="mt-0.5 text-[10px] text-ink-500">{range.lastScanMessage}</p> : null}
                    </div>
                    {canWrite ? (
                      <div className="flex gap-1">
                        <button type="button" className="btn-ghost btn-xs" onClick={() => openEdit(range)} aria-label="ویرایش">
                          <Edit3 size={13} />
                        </button>
                        <button type="button" className="btn-ghost btn-xs text-red-600" onClick={() => remove(range)} aria-label="حذف">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>

        <Card padded={false} className="p-4">
          <CardHeader
            title="تجهیزات کشف‌شده"
            subtitle={`${faDigits(results.data?.total ?? 0)} مورد تازه · به‌روزرسانی ${updatedAt ? fmtRelative(updatedAt) : '—'}`}
            icon={<Bell size={18} />}
            action={
              <button type="button" className="btn-ghost btn-xs" onClick={() => results.refresh()} disabled={results.refreshing}>
                <RefreshCw size={13} className={results.refreshing ? 'animate-spin' : ''} />
              </button>
            }
          />
          <div className="relative mt-3">
            <Search size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-400" />
            <input className="field !py-2 !pr-9 text-[12px]" placeholder="جست‌وجو در IP یا محدوده…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="mt-3 max-h-[480px] space-y-2 overflow-auto pr-1">
            {filteredResults.length === 0 ? (
              <EmptyState
                title="تجهیز تازه‌ای در فهرست نیست"
                description="پس از اسکن، میزبان‌های جدید (حداکثر ۲۴ ساعت) این‌جا نمایش داده می‌شوند."
              />
            ) : (
              filteredResults.map((row) => (
                <div key={row.id} className="rounded-soft border border-emerald-200/70 bg-emerald-50/30 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="emerald">تازه</Badge>
                    <span className="num text-[12.5px] font-semibold text-ink-800" dir="ltr">
                      {row.ip}
                    </span>
                    {row.openPorts.length ? (
                      <span className="num text-[10px] text-ink-500" dir="ltr">
                        ports: {row.openPorts.join(', ')}
                      </span>
                    ) : null}
                    <span className="ms-auto inline-flex items-center gap-1 text-[10px] text-ink-500">
                      <Clock size={11} />
                      {remainingLabel(row.expiresAt, now)}
                    </span>
                  </div>
                  <p className="mt-1 text-[10.5px] text-ink-500">
                    محدوده: {row.rangeName || '—'} · کشف: {fmtRelative(row.discoveredAt)}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {canWrite ? (
                      <>
                        <button type="button" className="btn-soft btn-xs" onClick={() => importResult(row)}>
                          <Server size={12} />
                          ثبت در تجهیزات
                        </button>
                        <button type="button" className="btn-ghost btn-xs text-red-600" onClick={() => dismiss(row)}>
                          <X size={12} />
                          حذف از فهرست
                        </button>
                      </>
                    ) : (
                      <Link to="/devices" className="text-[11px] text-brand-600 underline">
                        مشاهدهٔ تجهیزات
                      </Link>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? `ویرایش محدوده — ${editing.name}` : 'محدودهٔ کشف جدید'}
        subtitle=" فقط زیرشبکهٔ داخلی و کوچک انتخاب کنید؛ محدودهٔ بزرگ‌تر از سقف مجاز رد می‌شود."
        footer={
          <>
            <button type="button" className="btn-ghost" onClick={() => setFormOpen(false)}>
              انصراف
            </button>
            <button type="button" className="btn-primary" onClick={save}>
              ذخیره
            </button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="نام محدوده" required>
            <input className="field" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="مثلاً ساختمان اداری — طبقه ۳" />
          </Field>
          <Field label="محدودهٔ CIDR" required hint={`حداکثر ${faDigits(limits?.maxHosts ?? 256)} میزبان`}>
            <input dir="ltr" className="field num" value={form.cidr} onChange={(e) => setForm((f) => ({ ...f, cidr: e.target.value }))} placeholder="192.168.10.0/24" />
          </Field>
          <Field label="بازهٔ اسکن خودکار (ساعت)" hint="عدد بین ۱ تا ۱۶۸">
            <input dir="ltr" type="number" min={1} max={168} className="field num" value={form.intervalHours} onChange={(e) => setForm((f) => ({ ...f, intervalHours: e.target.value }))} />
          </Field>
          <div className="flex items-end pb-1">
            <Toggle checked={form.enabled} onChange={(v) => setForm((f) => ({ ...f, enabled: v }))} label="محدوده فعال است" hint="فقط محدوده‌های فعال به‌صورت خودکار اسکن می‌شوند" />
          </div>
          <Field label="یادداشت" className="sm:col-span-2">
            <textarea className="field min-h-[70px]" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
          </Field>
          <p className="sm:col-span-2 rounded-soft border border-ink-200 bg-ink-50/60 p-3 text-[10.5px] leading-relaxed text-ink-500">
            شبکه‌های مجاز فعلی: <span className="num" dir="ltr">{(limits?.allowedCidrs ?? []).join(', ') || '—'}</span>
          </p>
        </div>
      </Modal>
    </div>
  );
}
