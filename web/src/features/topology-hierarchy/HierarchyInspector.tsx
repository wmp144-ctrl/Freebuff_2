/**
 * بازرس توپولوژی
 * ----------------------------------------------------------------
 * انتخاب گره → مشخصات تجهیز/مرکز و لینک‌های متصل.
 * انتخاب لینک → رسانه، ظرفیت، تأخیر، وضعیت و دو سر لینک.
 * بدون انتخاب → خلاصهٔ دامنهٔ جاری (تعداد گره/لینک/وضعیت) و راهنمای استفاده.
 */
import React from 'react';
import { ChevronLeft, Info, Link2, Network, X } from 'lucide-react';
import { Badge, StatusPill } from '../../components/ui';
import { faDigits, statusMeta } from '../../lib/format';
import {
  KIND_META,
  LINK_STATE_META,
  MEDIA_META,
  MEDIUM_ORDER,
  childrenOf,
  isDrillable,
  type LinkState,
  type ScopeStats,
  type TopologyEdgeModel,
  type TopologyNodeModel,
} from '../../lib/topology-hierarchy';
import type { HierarchyGroupRef } from '../../lib/types';
import { KIND_ICONS } from './HierarchyNode';
import { MediaSample } from './MediaLegend';
import { ConnectionEditForm, NodeEditForm } from './HierarchyForms';
import { fmtBandwidth, fmtCount, fmtLatency } from './format';

interface Props {
  scopeTitle: string;
  scopeHint: string;
  allNodes: TopologyNodeModel[];
  allEdges: TopologyEdgeModel[];
  stats: ScopeStats;
  selectedNode: TopologyNodeModel | null;
  selectedEdge: TopologyEdgeModel | null;
  onDrill: (node: TopologyNodeModel) => void;
  onJumpToNode: (id: string) => void;
  onSelectEdge: (id: string) => void;
  onClear: () => void;
  /** ویرایش فقط زمانی فعال است که حالت ویرایش و مجوز نوشتن وجود داشته باشد */
  edit: boolean;
  groups: HierarchyGroupRef[];
  saving: boolean;
  formError: string;
  onSaveNode: (body: Record<string, unknown>) => Promise<boolean>;
  onSaveEdge: (body: Record<string, unknown>) => Promise<boolean>;
  onDeleteNode: () => void;
  onDeleteEdge: () => void;
  onAddConnection: () => void;
  onDirtyChange: (dirty: boolean) => void;
  /** افزایش این مقدار فرم‌های باز را بازنشانی می‌کند (پس از Undo/Redo) */
  resetToken?: number;
  className?: string;
}

const STATE_TONE: Record<LinkState, 'emerald' | 'red' | 'sun' | 'ink'> = {
  up: 'emerald',
  down: 'red',
  degraded: 'sun',
  unknown: 'ink',
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-ink-100 py-1.5 last:border-0">
      <dt className="shrink-0 text-[10.5px] text-ink-400">{label}</dt>
      <dd className="min-w-0 text-end text-[11.5px] font-medium text-ink-700">{children}</dd>
    </div>
  );
}

function Stat({ label, value, tone = 'ink' }: { label: string; value: string; tone?: 'ink' | 'emerald' | 'red' | 'sun' }) {
  const tones: Record<string, string> = {
    ink: 'border-ink-200 bg-ink-50/70 text-ink-700',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    red: 'border-red-200 bg-red-50 text-red-600',
    sun: 'border-sun-200 bg-sun-50 text-sun-700',
  };
  return (
    <div className={`rounded-soft border px-2 py-1.5 text-center ${tones[tone]}`}>
      <p className="num text-[15px] font-bold leading-5">{value}</p>
      <p className="text-[9.5px] opacity-80">{label}</p>
    </div>
  );
}

export default function HierarchyInspector({
  scopeTitle,
  scopeHint,
  allNodes,
  allEdges,
  stats,
  selectedNode,
  selectedEdge,
  onDrill,
  onJumpToNode,
  onSelectEdge,
  onClear,
  edit,
  groups,
  saving,
  formError,
  onSaveNode,
  onSaveEdge,
  onDeleteNode,
  onDeleteEdge,
  onAddConnection,
  onDirtyChange,
  resetToken = 0,
  className = '',
}: Props) {
  const byId = React.useMemo(() => new Map(allNodes.map((n) => [n.id, n])), [allNodes]);

  const connectedEdges = selectedNode
    ? allEdges.filter((e) => e.source === selectedNode.id || e.target === selectedNode.id)
    : [];
  const children = selectedNode ? childrenOf(allNodes, selectedNode.id) : [];

  return (
    <div className={`card flex h-full flex-col overflow-hidden ${className}`}>
      <div className="flex shrink-0 items-center gap-2 border-b border-ink-100 px-3 py-2.5">
        <span className="grid h-7 w-7 place-items-center rounded-lg border border-brand-100 bg-brand-50 text-brand-600">
          <Info size={14} />
        </span>
        <p className="text-[12.5px] font-semibold text-ink-800">بازرس</p>
        {selectedEdge ? (
          <Badge tone="sun">لینک</Badge>
        ) : selectedNode ? (
          <Badge tone="brand">{KIND_META[selectedNode.kind].label}</Badge>
        ) : null}
        {selectedNode || selectedEdge ? (
          <button
            type="button"
            onClick={onClear}
            className="ms-auto grid h-7 w-7 place-items-center rounded-lg text-ink-400 transition hover:bg-ink-50 hover:text-ink-700"
            title="پاک کردن انتخاب"
            aria-label="پاک کردن انتخاب"
          >
            <X size={14} />
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {selectedEdge && edit ? (
          <ConnectionEditForm
            key={`${selectedEdge.id}:${resetToken}`}
            edge={selectedEdge}
            nodes={allNodes}
            saving={saving}
            error={formError}
            onSave={onSaveEdge}
            onDelete={onDeleteEdge}
            onDirtyChange={onDirtyChange}
          />
        ) : selectedEdge ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2">
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-soft border border-ink-200 bg-white">
                <MediaSample medium={selectedEdge.medium} width={22} />
              </span>
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-ink-800">{MEDIA_META[selectedEdge.medium].label}</p>
                <p className="mt-0.5 text-[10.5px] text-ink-500">{selectedEdge.label ?? 'لینک بدون برچسب'}</p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone={STATE_TONE[selectedEdge.state ?? 'unknown']}>
                {LINK_STATE_META[selectedEdge.state ?? 'unknown'].label}
              </Badge>
              <Badge tone="ink">{MEDIA_META[selectedEdge.medium].hint}</Badge>
            </div>

            <dl className="rounded-soft border border-ink-100 bg-white/70 px-3 py-1">
              <Row label="مبدأ">
                <button
                  type="button"
                  className="max-w-[170px] truncate text-brand-700 hover:underline"
                  onClick={() => onJumpToNode(selectedEdge.source)}
                >
                  {byId.get(selectedEdge.source)?.name ?? selectedEdge.source}
                </button>
              </Row>
              <Row label="مقصد">
                <button
                  type="button"
                  className="max-w-[170px] truncate text-brand-700 hover:underline"
                  onClick={() => onJumpToNode(selectedEdge.target)}
                >
                  {byId.get(selectedEdge.target)?.name ?? selectedEdge.target}
                </button>
              </Row>
              <Row label="نقش">{selectedEdge.role === 'backup' ? 'پشتیبان' : 'اصلی'}</Row>
              <Row label="ظرفیت">{fmtBandwidth(selectedEdge.capacityMbps)}</Row>
              <Row label="تأخیر">{fmtLatency(selectedEdge.latencyMs)}</Row>
              {selectedEdge.sourcePort ? (
                <Row label="پورت مبدأ">
                  <span className="num ltr">{selectedEdge.sourcePort}</span>
                </Row>
              ) : null}
              {selectedEdge.targetPort ? (
                <Row label="پورت مقصد">
                  <span className="num ltr">{selectedEdge.targetPort}</span>
                </Row>
              ) : null}
              {selectedEdge.description ? <Row label="توضیح">{selectedEdge.description}</Row> : null}
              {selectedEdge.notes ? <Row label="یادداشت">{selectedEdge.notes}</Row> : null}
              <Row label="شناسه">
                <span className="num ltr text-[10.5px] text-ink-500">{selectedEdge.id}</span>
              </Row>
            </dl>

            {Object.entries(selectedEdge.meta ?? {}).length > 0 ? (
              <dl className="rounded-soft border border-ink-100 bg-white/70 px-3 py-1">
                {Object.entries(selectedEdge.meta ?? {}).map(([key, value]) => (
                  <Row key={key} label={key}>
                    {String(value)}
                  </Row>
                ))}
              </dl>
            ) : null}
          </div>
        ) : selectedNode && edit ? (
          <div className="space-y-2.5">
            <div className="flex items-center gap-2 rounded-soft border border-brand-100 bg-brand-50/60 px-2.5 py-2">
              {(() => {
                const Icon = KIND_ICONS[selectedNode.kind] ?? KIND_ICONS.other;
                return <Icon size={13} style={{ color: KIND_META[selectedNode.kind].color }} />;
              })()}
              <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-ink-700">
                {selectedNode.name}
              </span>
              <span className="shrink-0 text-[9.5px] text-ink-400">{KIND_META[selectedNode.kind].label}</span>
            </div>
            <NodeEditForm
              key={`${selectedNode.id}:${resetToken}`}
              node={selectedNode}
              groups={groups}
              saving={saving}
              error={formError}
              onSave={onSaveNode}
              onDelete={onDeleteNode}
              onDirtyChange={onDirtyChange}
            />
            <button type="button" className="btn-soft btn-xs w-full" onClick={onAddConnection} disabled={saving}>
              <Link2 size={13} />
              افزودن لینک از این گره
            </button>
          </div>
        ) : selectedNode ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2">
              {(() => {
                const Icon = KIND_ICONS[selectedNode.kind] ?? KIND_ICONS.other;
                return (
                  <span
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-soft border"
                    style={{
                      backgroundColor: `${KIND_META[selectedNode.kind].color}14`,
                      borderColor: `${KIND_META[selectedNode.kind].color}33`,
                      color: KIND_META[selectedNode.kind].color,
                    }}
                  >
                    <Icon size={17} />
                  </span>
                );
              })()}
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold leading-5 text-ink-800">{selectedNode.name}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <StatusPill status={selectedNode.status ?? 'unknown'} size="sm" />
                  <Badge tone="ink">{KIND_META[selectedNode.kind].label}</Badge>
                </div>
              </div>
            </div>

            <div className="rounded-soft border border-ink-100 bg-ink-50/60 px-3 py-2">
              <p className="text-[10px] text-ink-400">آدرس IP</p>
              <p className="num ltr mt-0.5 text-[13px] font-semibold text-ink-800">{selectedNode.ip || '—'}</p>
            </div>

            <dl className="rounded-soft border border-ink-100 bg-white/70 px-3 py-1">
              {selectedNode.deviceType ? <Row label="نوع">{selectedNode.deviceType}</Row> : null}
              {selectedNode.vendor ? <Row label="سازنده">{selectedNode.vendor}</Row> : null}
              {selectedNode.model ? <Row label="مدل">{selectedNode.model}</Row> : null}
              {selectedNode.location ? <Row label="موقعیت">{selectedNode.location}</Row> : null}
              {selectedNode.ports != null ? <Row label="پورت‌ها">{faDigits(selectedNode.ports)}</Row> : null}
              {selectedNode.ownerGroupName ? (
                <Row label="گروه مالک">{selectedNode.ownerGroupName}</Row>
              ) : null}
              {selectedNode.cityId && selectedNode.kind !== 'city' ? (
                <Row label="شهر">{byId.get(selectedNode.cityId)?.name ?? '—'}</Row>
              ) : null}
              <Row label="وضعیت">{statusMeta(selectedNode.status ?? 'unknown').label}</Row>
              {selectedNode.description ? <Row label="توضیح">{selectedNode.description}</Row> : null}
              {selectedNode.notes ? <Row label="یادداشت">{selectedNode.notes}</Row> : null}
            </dl>

            {isDrillable(selectedNode) ? (
              <button type="button" className="btn-soft btn-xs w-full" onClick={() => onDrill(selectedNode)}>
                <ChevronLeft size={14} />
                ورود به نمای {selectedNode.kind === 'city' ? 'شهر' : 'شبکهٔ داخلی'}
              </button>
            ) : null}

            {Object.entries(selectedNode.meta ?? {}).filter(([key]) => key !== 'lat' && key !== 'lng').length > 0 ? (
              <div>
                <p className="mb-1.5 text-[10.5px] font-semibold text-ink-500">مشخصات تکمیلی</p>
                <dl className="rounded-soft border border-ink-100 bg-white/70 px-3 py-1">
                  {Object.entries(selectedNode.meta ?? {})
                    .filter(([key]) => key !== 'lat' && key !== 'lng')
                    .map(([key, value]) => (
                      <Row key={key} label={key}>
                        {String(value)}
                      </Row>
                    ))}
                </dl>
              </div>
            ) : null}

            {children.length > 0 ? (
              <div>
                <p className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-semibold text-ink-500">
                  <Network size={12} />
                  زیرمجموعه‌ها
                  <span className="num rounded-pill bg-ink-100 px-1.5 text-[9.5px] text-ink-500">
                    {faDigits(children.length)}
                  </span>
                </p>
                <div className="space-y-1">
                  {children.slice(0, 8).map((child) => {
                    const Icon = KIND_ICONS[child.kind] ?? KIND_ICONS.other;
                    return (
                      <button
                        key={child.id}
                        type="button"
                        onClick={() => onJumpToNode(child.id)}
                        className="flex w-full items-center gap-1.5 rounded-lg border border-ink-100 bg-white/70 px-2 py-1.5 text-start transition hover:border-brand-200 hover:bg-brand-50/50"
                      >
                        <Icon size={11} style={{ color: KIND_META[child.kind].color }} />
                        <span className="min-w-0 flex-1 truncate text-[11px] text-ink-700">{child.name}</span>
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusMeta(child.status ?? 'unknown').dot}`} />
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {connectedEdges.length > 0 ? (
              <div>
                <p className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-semibold text-ink-500">
                  <Link2 size={12} />
                  لینک‌های متصل
                  <span className="num rounded-pill bg-ink-100 px-1.5 text-[9.5px] text-ink-500">
                    {faDigits(connectedEdges.length)}
                  </span>
                </p>
                <div className="space-y-1">
                  {connectedEdges.slice(0, 8).map((item) => {
                    const otherId = item.source === selectedNode.id ? item.target : item.source;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => onSelectEdge(item.id)}
                        className="flex w-full items-center gap-1.5 rounded-lg border border-ink-100 bg-white/70 px-2 py-1.5 text-start transition hover:border-brand-200 hover:bg-brand-50/50"
                      >
                        <MediaSample medium={item.medium} width={22} />
                        <span className="min-w-0 flex-1 truncate text-[11px] text-ink-700">
                          {byId.get(otherId)?.name ?? otherId}
                        </span>
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full`} style={{ backgroundColor: LINK_STATE_META[item.state ?? 'unknown'].color }} />
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <p className="text-[13px] font-semibold text-ink-800">{scopeTitle}</p>
              <p className="mt-0.5 text-[10.5px] text-ink-500">{scopeHint}</p>
            </div>

            <div className="grid grid-cols-4 gap-1.5">
              <Stat label="گره" value={fmtCount(stats.nodes)} />
              <Stat label="لینک" value={fmtCount(stats.edges)} />
              <Stat label="سالم" value={fmtCount(stats.online)} tone="emerald" />
              <Stat label="قطع" value={fmtCount(stats.offline)} tone="red" />
            </div>

            <div>
              <p className="mb-1.5 text-[10.5px] font-semibold text-ink-500">ترکیب رسانه‌ها</p>
              <div className="space-y-1">
                {MEDIUM_ORDER.map((medium) => (
                  <div
                    key={medium}
                    className="flex items-center gap-2 rounded-lg border border-ink-100 bg-white/70 px-2 py-1.5"
                  >
                    <MediaSample medium={medium} />
                    <span className="flex-1 text-[11px] text-ink-600">{MEDIA_META[medium].label}</span>
                    <span className="num text-[11px] font-semibold text-ink-700">
                      {faDigits(stats.byMedium[medium])}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {stats.warning > 0 ? (
              <p className="rounded-soft border border-sun-200 bg-sun-50 px-2.5 py-2 text-[10.5px] text-sun-700">
                {faDigits(stats.warning)} گره دارای اختلال در این نماست؛ جزئیات هر گره با کلیک روی آن دیده می‌شود.
              </p>
            ) : null}

            <p className="rounded-soft border border-dashed border-ink-200 bg-ink-50/60 px-2.5 py-2 text-[10.5px] leading-5 text-ink-500">
              با کلیک روی هر گره یا لینک، جزئیات آن این‌جا نمایش داده می‌شود. دوبار کلیک روی شهر، مرکز تجمع یا
              ایستگاه، نمای بعدی را باز می‌کند.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
