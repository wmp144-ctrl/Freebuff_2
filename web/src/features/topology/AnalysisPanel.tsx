/**
 * پنل تحلیل شبکه (مرحلهٔ ۳)
 * ----------------------------------------------------------------
 * خروجی موتور تحلیل را به زبان عملیاتی نشان می‌دهد:
 *   • رخدادهای فعال و محل دقیق قطع تا مرکز زیرساخت
 *   • نقاط بحرانی و تعداد تجهیزات وابسته
 *   • لینک‌های تک‌مسیره (پل) و شبیه‌سازی اثر قطع
 *   • تعریف مسیر اصلی/پشتیبان از گره‌های انتخاب‌شده روی بوم
 *
 * پنل هیچ محاسبهٔ وابستگی انجام نمی‌دهد؛ همهٔ اعداد از سرور می‌آید و فقط
 * انتخاب/نمایش سمت کلاینت است.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Building2,
  Cloud,
  Eye,
  EyeOff,
  GitBranch,
  Loader2,
  Network,
  Play,
  RefreshCw,
  Route as RouteIcon,
  Server,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import type {
  TopoAnalysis,
  TopoImpact,
  TopoNode,
  TopoPathDefinition,
  TopoRedundancyGroup,
  TopoRiskSeverity,
  TopoRouteStatus,
} from '../../lib/types';
import { faDigits, fmtRelative } from '../../lib/format';
import {
  GROUP_STATUS_META,
  ROUTE_STATUS_META,
  SEVERITY_META,
  TOPO_ROLE_LABEL,
  pathEndpoints,
  removePathGroup,
  selectedNodePath,
  upsertPath,
} from '../../lib/topology-analysis';
import { Badge, Spinner } from '../../components/ui';

interface Props {
  analysis: TopoAnalysis | null;
  loading: boolean;
  error: string;
  impact: TopoImpact | null;
  impactLoading: boolean;
  nodeById: Map<string, TopoNode>;
  selectedNodeIds: string[];
  readOnly: boolean;
  activeGroupName: string;
  savingPaths: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onSimulateLink: (id: string) => void;
  onSimulateNode: (id: string) => void;
  onClearImpact: () => void;
  onShowGroup: (name: string) => void;
  onSavePaths: (paths: TopoPathDefinition[]) => Promise<boolean>;
}

function severityChip(severity: TopoRiskSeverity, label?: string) {
  const meta = SEVERITY_META[severity] ?? SEVERITY_META.low;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-pill border px-1.5 py-0.5 text-[9.5px] ${meta.border} ${meta.soft} ${meta.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      {label || meta.label}
    </span>
  );
}

function routeChip(status: TopoRouteStatus) {
  const meta = ROUTE_STATUS_META[status] ?? ROUTE_STATUS_META.unknown;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-pill border px-1.5 py-0.5 text-[9.5px] ${meta.border} ${meta.soft} ${meta.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  );
}

function roleIcon(role: string) {
  if (role === 'site') return <Building2 size={12} />;
  if (role === 'cloud') return <Cloud size={12} />;
  if (role === 'server') return <Server size={12} />;
  return <Network size={12} />;
}

function groupChip(group: TopoRedundancyGroup) {
  const meta = GROUP_STATUS_META[group.status] ?? GROUP_STATUS_META.unknown;
  return (
    <span className={`inline-flex items-center gap-1 rounded-pill border px-1.5 py-0.5 text-[9.5px] ${meta.border} ${meta.soft} ${meta.text}`}>
      {meta.label}
    </span>
  );
}

function SectionTitle({ icon, title, hint }: { icon: React.ReactNode; title: string; hint?: string }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5">
      <span className="text-ink-500">{icon}</span>
      <p className="text-[11px] font-semibold text-ink-700">{title}</p>
      {hint ? <span className="text-[9.5px] text-ink-400">{hint}</span> : null}
    </div>
  );
}

function ImpactDetail({
  impact,
  loading,
  onClose,
}: {
  impact: TopoImpact;
  loading: boolean;
  onClose: () => void;
}) {
  const target = impact.target;
  const targetLabel = target.type === 'link' ? target.label : target.label;
  return (
    <section className="rounded-soft border border-violet-200 bg-violet-50/60 p-2.5" data-testid="analysis-impact">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 text-violet-600"><ShieldAlert size={13} /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-semibold text-ink-800">
            اثر قطع {target.type === 'link' ? 'لینک' : 'تجهیز'}: {targetLabel}
          </p>
          <p className="mt-0.5 text-[10px] text-ink-500">
            {impact.summary.alternateRoute
              ? 'مسیر جایگزین وجود دارد؛ هیچ تجهیزی از دسترس خارج نمی‌شود.'
              : impact.summary.affectedDeviceCount
                ? `${faDigits(impact.summary.affectedDeviceCount)} تجهیز از دسترس خارج می‌شود.`
                : 'تجهیز وابسته‌ای شناسایی نشد.'}
          </p>
        </div>
        <button type="button" className="btn-ghost btn-xs !px-1.5" onClick={onClose} aria-label="بستن نتیجهٔ شبیه‌سازی">
          <X size={12} />
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1">
        {severityChip(impact.summary.severity, impact.summary.severityLabel)}
        <span className="rounded-pill border border-ink-200 bg-white px-1.5 py-0.5 text-[9.5px] text-ink-500">
          {faDigits(impact.summary.affectedSiteCount)} مرکز/سایت
        </span>
        {impact.summary.alternateRoute ? (
          <span className="rounded-pill border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[9.5px] text-emerald-700">مسیر جایگزین</span>
        ) : null}
        {impact.summary.alreadyAffected ? (
          <span className="rounded-pill border border-red-200 bg-red-50 px-1.5 py-0.5 text-[9.5px] text-red-700">هم‌اکنون نیز قطع است</span>
        ) : null}
        {loading ? <Loader2 size={12} className="animate-spin text-violet-500" /> : null}
      </div>

      {impact.backupActivated.length ? (
        <div className="mt-2 rounded-lg border border-violet-200 bg-white px-2 py-1.5">
          <p className="text-[9.5px] font-semibold text-violet-700">مسیر پشتیبان فعال می‌شود</p>
          {impact.backupActivated.map((item) => (
            <p key={item.name} className="mt-0.5 flex items-center gap-1 text-[10px] text-ink-600">
              <GitBranch size={10} className="text-violet-500" />
              {item.name}
              <span className="text-ink-400">·</span>
              {faDigits(item.backupHops)} گام
              {routeChip(item.backupStatus)}
            </p>
          ))}
        </div>
      ) : null}

      {impact.affected.devices.length ? (
        <div className="mt-2 max-h-32 space-y-0.5 overflow-y-auto">
          {impact.affected.devices.map((device) => (
            <div key={device.id} className="flex items-center gap-1.5 rounded-lg bg-white/80 px-1.5 py-1 text-[10px]">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${device.status === 'offline' ? 'bg-red-500' : device.status === 'online' ? 'bg-emerald-500' : 'bg-ink-300'}`} />
              <span className="min-w-0 flex-1 truncate text-ink-700">{device.label}</span>
              {device.isTarget ? <span className="shrink-0 text-[9px] text-red-600">هدف</span> : null}
              <span className="num shrink-0 text-[9px] text-ink-400">{device.ip}</span>
            </div>
          ))}
          {impact.affected.truncated ? <p className="px-1 text-[9px] text-ink-400">فهرست کامل در API موجود است.</p> : null}
        </div>
      ) : null}

      {impact.paths.length ? (
        <div className="mt-2 rounded-lg border border-ink-200 bg-white p-1.5">
          <p className="text-[9.5px] font-semibold text-ink-600">مسیر قطع تا مرکز زیرساخت</p>
          <div className="mt-1 max-h-32 space-y-1 overflow-y-auto">
            {impact.paths.slice(0, 6).map((path) => (
              <div key={path.nodeId} className="text-[9.5px] leading-5 text-ink-500">
                <span className="font-medium text-ink-700">{path.label}:</span>{' '}
                {path.pathLabels.map((label, index) => (
                  <React.Fragment key={`${path.nodeId}-${index}`}>
                    {index ? <span className="mx-0.5 text-ink-300">←</span> : null}
                    <span className={index === path.pathLabels.length - 1 ? 'font-medium text-ink-700' : ''}>{label}</span>
                  </React.Fragment>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default function AnalysisPanel({
  analysis,
  loading,
  error,
  impact,
  impactLoading,
  nodeById,
  selectedNodeIds,
  readOnly,
  activeGroupName,
  savingPaths,
  onClose,
  onRefresh,
  onSimulateLink,
  onSimulateNode,
  onClearImpact,
  onShowGroup,
  onSavePaths,
}: Props) {
  const [pathName, setPathName] = useState('');
  const [pathError, setPathError] = useState('');
  const [savingRole, setSavingRole] = useState<'primary' | 'backup' | null>(null);

  const sequence = useMemo(
    () => selectedNodePath([...nodeById.values()], selectedNodeIds),
    [nodeById, selectedNodeIds]
  );

  const suggestion = useMemo(() => {
    if (sequence.length < 2) return '';
    return `${sequence[0].label} ↔ ${sequence[sequence.length - 1].label}`;
  }, [sequence]);

  useEffect(() => {
    setPathError('');
  }, [selectedNodeIds]);

  const addPath = async (role: 'primary' | 'backup') => {
    if (!analysis) return;
    if (sequence.length < 2) {
      setPathError('برای ساخت مسیر، ابتدا با Shift حداقل دو گره را به ترتیب روی بوم انتخاب کنید.');
      return;
    }
    const name = (pathName.trim() || suggestion).slice(0, 120);
    if (!name) {
      setPathError('نام مسیر را وارد کنید.');
      return;
    }
    const next = upsertPath(analysis.paths, { name, role, nodeIds: sequence.map((item) => item.id) });
    setSavingRole(role);
    setPathError('');
    const ok = await onSavePaths(next);
    setSavingRole(null);
    if (ok) {
      setPathName('');
      onShowGroup(name);
    }
  };

  const removeGroup = async (name: string) => {
    if (!analysis) return;
    setSavingRole('primary');
    setPathError('');
    const ok = await onSavePaths(removePathGroup(analysis.paths, name));
    setSavingRole(null);
    if (ok && activeGroupName === name) onShowGroup('');
  };

  return (
    <div
      className="absolute inset-y-3 right-3 z-30 flex w-[min(392px,calc(100%-1.5rem))] flex-col overflow-hidden rounded-card border border-white/80 bg-white/97 shadow-pop backdrop-blur-xl"
      data-testid="analysis-panel"
    >
      <header className="flex items-start justify-between gap-2 border-b border-ink-100 p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[10px] text-ink-400">
            <Badge tone="violet">تحلیل وابستگی</Badge>
            {analysis ? <span>به‌روزرسانی {fmtRelative(analysis.generatedAt)}</span> : null}
          </div>
          <h3 className="mt-1 text-[13px] font-semibold text-ink-800">سلامت زنجیرهٔ ارتباطی</h3>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button type="button" className="btn-ghost btn-xs !px-1.5" onClick={onRefresh} disabled={loading} title="تحلیل دوباره" aria-label="تحلیل دوباره">
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          </button>
          <button type="button" className="btn-ghost btn-xs !px-1.5" onClick={onClose} title="بستن" aria-label="بستن تحلیل">
            <X size={14} />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {error ? (
          <div className="flex items-start gap-2 rounded-soft border border-red-100 bg-red-50 p-2.5 text-[11px] text-red-700">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button type="button" className="text-[10px] font-medium underline" onClick={onRefresh}>تلاش دوباره</button>
          </div>
        ) : null}

        {!analysis && loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[11px] text-ink-400">
            <Spinner /> در حال تحلیل ساختار ارتباطات…
          </div>
        ) : null}

        {analysis ? (
          <>
            {analysis.warning ? (
              <div className="flex items-start gap-1.5 rounded-soft border border-amber-100 bg-amber-50 p-2 text-[10px] leading-5 text-amber-800">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                {analysis.warning}
              </div>
            ) : null}

            <div className="grid grid-cols-2 gap-1.5">
              <div className="rounded-soft border border-ink-200 bg-ink-50/60 px-2 py-1.5">
                <p className="text-[9.5px] text-ink-400">قطعی فعلی</p>
                <p className="num mt-0.5 text-base font-bold text-red-600">{faDigits(analysis.live.affectedDeviceCount)}</p>
                <p className="text-[9px] text-ink-400">تجهیز متأثر</p>
              </div>
              <div className="rounded-soft border border-ink-200 bg-ink-50/60 px-2 py-1.5">
                <p className="text-[9.5px] text-ink-400">نقاط بحرانی</p>
                <p className="num mt-0.5 text-base font-bold text-amber-600">{faDigits(analysis.summary.criticalNodeCount)}</p>
                <p className="text-[9px] text-ink-400">تجهیز واسط</p>
              </div>
              <div className="rounded-soft border border-ink-200 bg-ink-50/60 px-2 py-1.5">
                <p className="text-[9.5px] text-ink-400">لینک‌های تک‌مسیره</p>
                <p className="num mt-0.5 text-base font-bold text-orange-600">{faDigits(analysis.summary.riskyLinkCount)}</p>
                <p className="text-[9px] text-ink-400">بدون مسیر جایگزین</p>
              </div>
              <div className="rounded-soft border border-ink-200 bg-ink-50/60 px-2 py-1.5">
                <p className="text-[9.5px] text-ink-400">پشتیبان فعال</p>
                <p className="num mt-0.5 text-base font-bold text-violet-600">{faDigits(analysis.summary.activeBackupCount)}</p>
                <p className="text-[9px] text-ink-400">از {faDigits(analysis.summary.redundancyGroupCount)} گروه</p>
              </div>
            </div>

            <div className="rounded-soft border border-ink-200 px-2 py-1.5">
              <p className="text-[9.5px] text-ink-400">مبنای مرکز زیرساخت</p>
              <div className="mt-1 flex flex-wrap items-center gap-1">
                {analysis.anchors.length ? (
                  analysis.anchors.map((anchor) => (
                    <span key={anchor.id} className="inline-flex items-center gap-1 rounded-pill border border-brand-100 bg-brand-50 px-1.5 py-0.5 text-[9.5px] text-brand-700">
                      {roleIcon(anchor.role)}
                      {anchor.label}
                      {anchor.roleLabel ? <span className="text-brand-400">({anchor.roleLabel})</span> : null}
                    </span>
                  ))
                ) : (
                  <span className="text-[10px] text-red-600">مرکز متصلی وجود ندارد.</span>
                )}
              </div>
            </div>

            {impact ? (
              <ImpactDetail impact={impact} loading={impactLoading} onClose={onClearImpact} />
            ) : impactLoading ? (
              <div className="flex items-center gap-2 rounded-soft border border-violet-100 bg-violet-50/60 px-2 py-2 text-[10.5px] text-violet-700">
                <Loader2 size={12} className="animate-spin" /> در حال شبیه‌سازی اثر قطع…
              </div>
            ) : null}

            <section>
              <SectionTitle icon={<AlertTriangle size={12} />} title="رخدادهای فعال" hint={`${faDigits(analysis.live.incidents.length)} مورد`} />
              {analysis.live.incidents.length ? (
                <div className="space-y-1">
                  {analysis.live.incidents.map((incident) => (
                    <button
                      key={`${incident.type}:${incident.id}`}
                      type="button"
                      className="flex w-full items-start gap-1.5 rounded-lg border border-ink-200 bg-white px-2 py-1.5 text-right hover:border-red-200 hover:bg-red-50/50"
                      onClick={() =>
                        incident.type === 'link' ? onSimulateLink(incident.id) : onSimulateNode(incident.id)
                      }
                    >
                      <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${incident.status === 'degraded' ? 'bg-amber-500' : 'bg-red-500'}`} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[10.5px] font-medium text-ink-700">{incident.label}</span>
                        <span className="block truncate text-[9.5px] text-ink-400">
                          {incident.type === 'link' ? 'قطع لینک' : 'تجهیز قطع'} · {incident.affectedDeviceCount ? `${faDigits(incident.affectedDeviceCount)} تجهیز پایین‌دست` : 'بدون تجهیز پایین‌دست'}
                        </span>
                      </span>
                      <ArrowLeft size={12} className="mt-1 shrink-0 text-ink-300" />
                    </button>
                  ))}
                </div>
              ) : (
                <p className="rounded-lg bg-emerald-50 px-2 py-1.5 text-[10px] text-emerald-700">در حال حاضر قطعی یا اختلالی در ساختار ثبت نشده است.</p>
              )}
            </section>

            {analysis.live.cutPaths.length ? (
              <section>
                <SectionTitle icon={<RouteIcon size={12} />} title="محل قطع تا مرکز" hint="مسیر واقعی روی گراف" />
                <div className="space-y-1">
                  {analysis.live.cutPaths.slice(0, 5).map((cut) => (
                    <div key={cut.nodeId} className="rounded-lg border border-ink-200 px-2 py-1.5 text-[9.5px] leading-5">
                      <p className="truncate font-medium text-ink-700">{cut.label}</p>
                      <p className="text-ink-500">
                        {cut.pathLabels.map((label, index) => (
                          <React.Fragment key={`${cut.nodeId}-${index}`}>
                            {index ? <span className="mx-0.5 text-ink-300">←</span> : null}
                            <span className={label === cut.cutNodeLabel ? 'font-medium text-red-600' : ''}>{label}</span>
                          </React.Fragment>
                        ))}
                      </p>
                      {cut.cutLinkId ? <p className="text-[9px] text-red-600">قطع روی لینک: {cut.cutLinkLabel}</p> : null}
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <section>
              <SectionTitle icon={<ShieldAlert size={12} />} title="نقاط بحرانی" hint="خرابی آن‌ها شبکه را تقسیم می‌کند" />
              {analysis.criticalNodes.length ? (
                <div className="max-h-56 space-y-1 overflow-y-auto pr-0.5">
                  {analysis.criticalNodes.slice(0, 20).map((node) => (
                    <div key={node.id} className="flex items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-2 py-1.5">
                      <span className="text-amber-600">{roleIcon(node.role)}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[10.5px] font-medium text-ink-700">{node.label}</p>
                        <p className="text-[9px] text-ink-400">
                          {TOPO_ROLE_LABEL[node.role]} · {faDigits(node.dependentDeviceCount)} تجهیز وابسته
                          {node.ip ? ` · ${node.ip}` : ''}
                        </p>
                      </div>
                      {severityChip(node.severity)}
                      <button
                        type="button"
                        className="btn-ghost btn-xs !px-1.5"
                        onClick={() => onSimulateNode(node.id)}
                        title="شبیه‌سازی خرابی این تجهیز"
                        aria-label={`شبیه‌سازی خرابی ${node.label}`}
                      >
                        <Play size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="rounded-lg bg-ink-50 px-2 py-1.5 text-[10px] text-ink-500">نقطهٔ برشی با تجهیز وابسته پیدا نشد.</p>
              )}
            </section>

            <section>
              <SectionTitle icon={<GitBranch size={12} />} title="لینک‌های تک‌مسیره" hint="قطع = از دست رفتن دسترسی" />
              {analysis.riskyLinks.length ? (
                <div className="max-h-48 space-y-1 overflow-y-auto pr-0.5">
                  {analysis.riskyLinks.slice(0, 15).map((link) => (
                    <div key={link.id} className="flex items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-2 py-1.5">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${link.status === 'down' ? 'bg-red-500' : link.status === 'degraded' ? 'bg-amber-500' : 'bg-ink-300'}`} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[10.5px] font-medium text-ink-700">{link.label}</p>
                        <p className="truncate text-[9px] text-ink-400">{link.fromLabel} ↔ {link.toLabel}</p>
                      </div>
                      <span className="num shrink-0 text-[9.5px] text-ink-500">{faDigits(link.dependentDeviceCount)}</span>
                      <button type="button" className="btn-ghost btn-xs !px-1.5" onClick={() => onSimulateLink(link.id)} title="شبیه‌سازی قطع" aria-label={`شبیه‌سازی قطع ${link.label}`}>
                        <Play size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="rounded-lg bg-emerald-50 px-2 py-1.5 text-[10px] text-emerald-700">همهٔ لینک‌های متصل مسیر جایگزین دارند.</p>
              )}
            </section>

            <section>
              <SectionTitle icon={<RouteIcon size={12} />} title="مسیرهای اصلی و پشتیبان" />
              <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[9px] text-ink-500">
                <span className="inline-flex items-center gap-1"><span className="h-1 w-4 rounded bg-blue-500/40" /> اصلی</span>
                <span className="inline-flex items-center gap-1"><span className="h-1 w-4 rounded bg-violet-500/40" /> پشتیبان</span>
                <span className="inline-flex items-center gap-1"><span className="h-1 w-4 rounded bg-violet-700/50" /> مسیر مشکل‌دار</span>
              </div>
              {analysis.redundancy.groups.length ? (
                <div className="space-y-1">
                  {analysis.redundancy.groups.map((group) => (
                    <div key={group.name} className={`rounded-lg border px-2 py-1.5 ${activeGroupName === group.name ? 'border-brand-200 bg-brand-50/50' : 'border-ink-200 bg-white'}`}>
                      <div className="flex items-center gap-1.5">
                        <p className="min-w-0 flex-1 truncate text-[10.5px] font-semibold text-ink-700">{group.name}</p>
                        {groupChip(group)}
                        <button
                          type="button"
                          className="btn-ghost btn-xs !px-1.5"
                          onClick={() => onShowGroup(activeGroupName === group.name ? '' : group.name)}
                          title={activeGroupName === group.name ? 'پنهان‌کردن مسیرها' : 'نمایش روی بوم'}
                          aria-label={activeGroupName === group.name ? 'پنهان‌کردن مسیر' : 'نمایش مسیر روی بوم'}
                        >
                          {activeGroupName === group.name ? <EyeOff size={11} /> : <Eye size={11} />}
                        </button>
                        {!readOnly ? (
                          <button
                            type="button"
                            className="btn-ghost btn-xs !px-1.5 text-red-500"
                            onClick={() => void removeGroup(group.name)}
                            disabled={savingPaths}
                            title="حذف گروه مسیر"
                            aria-label={`حذف ${group.name}`}
                          >
                            <Trash2 size={11} />
                          </button>
                        ) : null}
                      </div>
                      <p className="mt-0.5 truncate text-[9px] text-ink-400">
                        {group.primary ? pathEndpoints(group.primary) : group.backup ? pathEndpoints(group.backup) : ''}
                      </p>
                      <div className="mt-1 space-y-0.5">
                        {(['primary', 'backup'] as const).map((role) => {
                          const route = group[role];
                          if (!route) return null;
                          return (
                            <div key={role} className="flex items-center gap-1 text-[9.5px]">
                              <span className={`w-9 shrink-0 ${role === 'primary' ? 'text-blue-600' : 'text-violet-600'}`}>{role === 'primary' ? 'اصلی' : 'پشتیبان'}</span>
                              {routeChip(route.status)}
                              <span className="min-w-0 flex-1 truncate text-ink-400">{faDigits(route.hops)} گام</span>
                              {route.active ? <span className="shrink-0 rounded-pill bg-emerald-50 px-1.5 py-0.5 text-[8.5px] text-emerald-700">فعال</span> : null}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="rounded-lg bg-ink-50 px-2 py-1.5 text-[10px] text-ink-500">هنوز مسیر اصلی/پشتیبانی تعریف نشده است.</p>
              )}

              {!readOnly ? (
                <div className="mt-2 rounded-lg border border-dashed border-brand-200 bg-brand-50/40 p-2">
                  <p className="text-[9.5px] font-medium text-brand-700">ساخت مسیر از انتخاب روی بوم</p>
                  {sequence.length >= 2 ? (
                    <div className="mt-1 flex flex-wrap items-center gap-1 text-[9.5px] text-ink-600">
                      {sequence.map((node, index) => (
                        <React.Fragment key={node.id}>
                          {index ? <ArrowLeft size={9} className="text-ink-300" /> : null}
                          <span className="rounded bg-white px-1 py-0.5">{node.label}</span>
                        </React.Fragment>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-1 text-[9.5px] leading-5 text-ink-500">
                      با <kbd className="rounded border border-ink-200 bg-white px-1">Shift</kbd> گره‌ها را به ترتیب کلیک کنید؛ ترتیب کلیک، ترتیب مسیر است.
                    </p>
                  )}
                  <div className="mt-1.5 flex items-center gap-1">
                    <input
                      className="field !py-1 text-[10.5px]"
                      value={pathName}
                      onChange={(event) => setPathName(event.target.value)}
                      placeholder={suggestion ? `نام گروه، پیش‌فرض: ${suggestion}` : 'نام گروه مسیر'}
                      maxLength={120}
                      aria-label="نام گروه مسیر"
                    />
                  </div>
                  {pathError ? <p className="mt-1 text-[9.5px] text-red-600">{pathError}</p> : null}
                  <div className="mt-1.5 flex gap-1">
                    <button
                      type="button"
                      className="btn-primary btn-xs flex-1 !py-1 text-[10px]"
                      onClick={() => void addPath('primary')}
                      disabled={savingPaths || sequence.length < 2}
                    >
                      {savingRole === 'primary' ? <Loader2 size={11} className="animate-spin" /> : <ArrowRight size={11} />}
                      ذخیره به‌عنوان اصلی
                    </button>
                    <button
                      type="button"
                      className="btn-ghost btn-xs flex-1 !py-1 text-[10px]"
                      onClick={() => void addPath('backup')}
                      disabled={savingPaths || sequence.length < 2}
                    >
                      {savingRole === 'backup' ? <Loader2 size={11} className="animate-spin" /> : <GitBranch size={11} />}
                      پشتیبان
                    </button>
                  </div>
                  {savingPaths ? <p className="mt-1 text-[9px] text-ink-400">در حال ذخیرهٔ مسیرها…</p> : null}
                </div>
              ) : null}
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}
