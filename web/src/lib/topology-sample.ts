/**
 * دادهٔ نمونهٔ توپولوژی شبکه — فقط برای حالت توسعه/نمایش
 * ----------------------------------------------------------------
 * این فایل هیچ‌گاه به API یا پایگاه‌داده دست نمی‌زند و چیزی ذخیره نمی‌کند.
 * فقط از مسیر `import('../lib/topology-sample')` و آن هم زمانی بارگذاری
 * می‌شود که حالت نمایش فعال باشد (سرور توسعه یا `?demo=1`). دادهٔ تولیدی
 * جدا می‌ماند و هرگز با این نمونه جایگزین یا بازنویسی نمی‌شود.
 *
 * ساختار: شهر ← مرکز تجمع/ایستگاه ← تجهیز. لینک‌ها با `medium` مشخص
 * می‌کنند با چه خطی رسم شوند (فیبر، بی‌سیم، اترنت، VPN).
 */
import type {
  LinkState,
  TopologyDataset,
  TopologyEdgeModel,
  TopologyNodeKind,
  TopologyNodeModel,
  TransmissionMedium,
} from './topology-hierarchy';

type NodeStatus = TopologyNodeModel['status'];

interface DeviceSpec {
  id: string;
  name: string;
  kind: TopologyNodeKind;
  parentId: string;
  ip: string;
  status?: NodeStatus;
  type?: string;
  vendor?: string;
  model?: string;
  location?: string;
  meta?: TopologyNodeModel['meta'];
}

/** یک تجهیز یا گرهٔ سطح پایین */
function dev(spec: DeviceSpec): TopologyNodeModel {
  return {
    id: spec.id,
    kind: spec.kind,
    name: spec.name,
    parentId: spec.parentId,
    ip: spec.ip,
    status: spec.status ?? 'online',
    deviceType: spec.type ?? null,
    vendor: spec.vendor ?? null,
    model: spec.model ?? null,
    location: spec.location ?? null,
    meta: spec.meta ?? {},
  };
}

interface SiteSpec {
  id: string;
  kind: 'aggregation' | 'station';
  name: string;
  parentId: string;
  ip: string;
  location: string;
  status?: NodeStatus;
  meta?: TopologyNodeModel['meta'];
}

/** مرکز تجمع یا ایستگاه */
function site(spec: SiteSpec): TopologyNodeModel {
  return {
    id: spec.id,
    kind: spec.kind,
    name: spec.name,
    parentId: spec.parentId,
    ip: spec.ip,
    status: spec.status ?? 'online',
    location: spec.location,
    meta: spec.meta ?? {},
  };
}

function city(id: string, name: string, lat: number, lng: number, status: NodeStatus, ip: string): TopologyNodeModel {
  return {
    id,
    kind: 'city',
    name,
    parentId: null,
    ip,
    status,
    meta: { lat, lng },
  };
}

const edge = (
  id: string,
  source: string,
  target: string,
  medium: TransmissionMedium,
  opts: { label?: string; capacityMbps?: number; latencyMs?: number; state?: LinkState; description?: string } = {}
): TopologyEdgeModel => ({
  id,
  source,
  target,
  medium,
  label: opts.label ?? null,
  capacityMbps: opts.capacityMbps ?? null,
  latencyMs: opts.latencyMs ?? null,
  state: opts.state ?? 'up',
  description: opts.description ?? null,
});

/**
 * ساخت یک نسخهٔ تازه از دیتاست نمونه. آرایه‌ها هر بار نو ساخته می‌شوند تا
 * کشیدن گره در حالت ویرایش، دادهٔ ماژول را تغییر ندهد.
 */
export function buildSampleTopology(): TopologyDataset {
  const nodes: TopologyNodeModel[] = [
    /* ---------------------------------------------------------------- */
    /* شهرها                                                            */
    /* ---------------------------------------------------------------- */
    city('city-thr', 'تهران', 35.6892, 51.389, 'online', '10.20.0.1'),
    city('city-mhd', 'مشهد', 36.2605, 59.6168, 'online', '10.30.0.1'),
    city('city-isf', 'اصفهان', 32.6546, 51.668, 'warning', '10.40.0.1'),
    city('city-shz', 'شیراز', 29.5918, 52.5837, 'online', '10.60.0.1'),
    city('city-tbz', 'تبریز', 38.08, 46.2919, 'warning', '10.50.0.1'),

    /* ---------------------------------------------------------------- */
    /* مراکز تجمع و ایستگاه‌ها                                           */
    /* ---------------------------------------------------------------- */
    site({
      id: 'agg-thr-n',
      kind: 'aggregation',
      name: 'مرکز تجمع تهران شمال',
      parentId: 'city-thr',
      ip: '10.20.1.1',
      location: 'تهران، سعادت‌آباد',
      meta: { 'تعداد رک': 12, 'ظرفیت برق': '۲×۶۳ آمپر' },
    }),
    site({
      id: 'agg-thr-s',
      kind: 'aggregation',
      name: 'مرکز تجمع تهران جنوب',
      parentId: 'city-thr',
      ip: '10.20.2.1',
      location: 'تهران، جوادیه',
      meta: { 'تعداد رک': 8 },
    }),
    site({
      id: 'agg-mhd-c',
      kind: 'aggregation',
      name: 'مرکز تجمع مشهد مرکزی',
      parentId: 'city-mhd',
      ip: '10.30.1.1',
      location: 'مشهد، بلوار وکیل‌آباد',
      meta: { 'تعداد رک': 10 },
    }),
    site({
      id: 'agg-isf-c',
      kind: 'aggregation',
      name: 'مرکز تجمع اصفهان',
      parentId: 'city-isf',
      ip: '10.40.1.1',
      location: 'اصفهان، بزرگمهر',
      status: 'warning',
      meta: { 'تعداد رک': 6 },
    }),
    site({
      id: 'agg-tbz-c',
      kind: 'aggregation',
      name: 'مرکز تجمع تبریز',
      parentId: 'city-tbz',
      ip: '10.50.1.1',
      location: 'تبریز، باغمیشه',
      meta: { 'تعداد رک': 6 },
    }),
    site({
      id: 'st-thr-vnk',
      kind: 'station',
      name: 'ایستگاه ونک',
      parentId: 'city-thr',
      ip: '10.20.11.1',
      location: 'تهران، میدان ونک',
      meta: { 'تعداد رک': 4 },
    }),
    site({
      id: 'st-thr-tjr',
      kind: 'station',
      name: 'ایستگاه تجریش',
      parentId: 'city-thr',
      ip: '10.20.12.1',
      location: 'تهران، تجریش',
      meta: { 'تعداد رک': 3 },
    }),
    site({
      id: 'st-mhd-hrm',
      kind: 'station',
      name: 'ایستگاه حرم',
      parentId: 'city-mhd',
      ip: '10.30.11.1',
      location: 'مشهد، حرم مطهر',
      meta: { 'تعداد رک': 3 },
    }),
    site({
      id: 'st-mhd-vkl',
      kind: 'station',
      name: 'ایستگاه وکیل‌آباد',
      parentId: 'city-mhd',
      ip: '10.30.12.1',
      location: 'مشهد، وکیل‌آباد',
      meta: { 'تعداد رک': 2 },
    }),
    site({
      id: 'st-isf-chb',
      kind: 'station',
      name: 'ایستگاه چهارباغ',
      parentId: 'city-isf',
      ip: '10.40.11.1',
      location: 'اصفهان، چهارباغ',
      status: 'warning',
      meta: { 'تعداد رک': 2 },
    }),
    site({
      id: 'st-shz-hfz',
      kind: 'station',
      name: 'ایستگاه حافظیه',
      parentId: 'city-shz',
      ip: '10.60.11.1',
      location: 'شیراز، حافظیه',
      meta: { 'تعداد رک': 3 },
    }),
    site({
      id: 'st-shz-mla',
      kind: 'station',
      name: 'ایستگاه معالی‌آباد',
      parentId: 'city-shz',
      ip: '10.60.12.1',
      location: 'شیراز، معالی‌آباد',
      status: 'warning',
      meta: { 'تعداد رک': 2 },
    }),
    site({
      id: 'st-tbz-vls',
      kind: 'station',
      name: 'ایستگاه ولیعصر',
      parentId: 'city-tbz',
      ip: '10.50.11.1',
      location: 'تبریز، ولیعصر',
      status: 'offline',
      meta: { 'تعداد رک': 2 },
    }),

    /* ---------------------------------------------------------------- */
    /* شبکهٔ داخلی مرکز تجمع تهران شمال (نمونهٔ کامل نمای جزئیات)         */
    /* ---------------------------------------------------------------- */
    dev({
      id: 'dev-thr-n-core',
      name: 'روتر هستهٔ تهران شمال',
      kind: 'router',
      parentId: 'agg-thr-n',
      ip: '10.20.1.1',
      type: 'روتر',
      vendor: 'Cisco',
      model: 'ISR 4451',
      location: 'سالن اصلی، رک ۱',
      meta: { 'نسخهٔ سیستم': 'IOS-XE 17.9.4', 'پورت‌های فعال': 22 },
    }),
    dev({
      id: 'dev-thr-n-fw',
      name: 'فایروال لبهٔ تهران شمال',
      kind: 'firewall',
      parentId: 'agg-thr-n',
      ip: '10.20.1.2',
      type: 'فایروال',
      vendor: 'Fortinet',
      model: 'FortiGate 100F',
      location: 'سالن اصلی، رک ۱',
      meta: { 'نسخهٔ سیستم': 'FortiOS 7.4', 'جلسات فعال': 18420 },
    }),
    dev({
      id: 'dev-thr-n-agg',
      name: 'سوئیچ تجمیع تهران شمال',
      kind: 'switch',
      parentId: 'agg-thr-n',
      ip: '10.20.1.3',
      type: 'سوئیچ',
      vendor: 'Cisco',
      model: 'Catalyst 9300',
      location: 'سالن اصلی، رک ۲',
      meta: { 'پورت‌های فعال': 41, 'نسخهٔ سیستم': 'IOS-XE 17.6' },
    }),
    dev({
      id: 'dev-thr-n-acc',
      name: 'سوئیچ دسترسی طبقهٔ سه',
      kind: 'switch',
      parentId: 'agg-thr-n',
      ip: '10.20.1.4',
      status: 'warning',
      type: 'سوئیچ',
      vendor: 'Cisco',
      model: 'Catalyst 9200',
      location: 'طبقهٔ سه، رک الف',
      meta: { 'پورت‌های فعال': 18, 'افت بسته': '۰٫۸٪' },
    }),
    dev({
      id: 'dev-thr-n-srv',
      name: 'سرور پایش NetWatch',
      kind: 'server',
      parentId: 'agg-thr-n',
      ip: '10.20.1.10',
      type: 'سرور',
      vendor: 'HPE',
      model: 'ProLiant DL380',
      location: 'سالن اصلی، رک ۴',
      meta: { 'نسخهٔ سیستم': 'Ubuntu 24.04', 'فضای آزاد': '۳۱۰ گیگابایت' },
    }),
    dev({
      id: 'dev-thr-n-bkp',
      name: 'ذخیره‌ساز پشتیبان',
      kind: 'server',
      parentId: 'agg-thr-n',
      ip: '10.20.1.11',
      status: 'offline',
      type: 'ذخیره‌ساز',
      vendor: 'Synology',
      model: 'RS3621',
      location: 'سالن اصلی، رک ۴',
      meta: { 'آخرین پشتیبان': '۲ روز پیش' },
    }),
    dev({
      id: 'dev-thr-n-ap',
      name: 'نقطهٔ دسترسی سالن عملیات',
      kind: 'access-point',
      parentId: 'agg-thr-n',
      ip: '10.20.1.21',
      type: 'دسترسی بی‌سیم',
      vendor: 'Ubiquiti',
      model: 'U6-Pro',
      location: 'سالن عملیات، سقف',
      meta: { 'کلاینت متصل': 14 },
    }),

    /* شبکهٔ داخلی مرکز تجمع تهران جنوب */
    dev({
      id: 'dev-thr-s-core',
      name: 'روتر تهران جنوب',
      kind: 'router',
      parentId: 'agg-thr-s',
      ip: '10.20.2.1',
      type: 'روتر',
      vendor: 'MikroTik',
      model: 'CCR2004',
      location: 'سالن اصلی، رک ۱',
    }),
    dev({
      id: 'dev-thr-s-sw',
      name: 'سوئیچ تهران جنوب',
      kind: 'switch',
      parentId: 'agg-thr-s',
      ip: '10.20.2.2',
      type: 'سوئیچ',
      vendor: 'Cisco',
      model: 'Catalyst 9200',
      location: 'سالن اصلی، رک ۲',
    }),
    dev({
      id: 'dev-thr-s-fw',
      name: 'فایروال تهران جنوب',
      kind: 'firewall',
      parentId: 'agg-thr-s',
      ip: '10.20.2.3',
      type: 'فایروال',
      vendor: 'Fortinet',
      model: 'FortiGate 60F',
      location: 'سالن اصلی، رک ۱',
    }),

    /* شبکهٔ داخلی ایستگاه ونک */
    dev({
      id: 'dev-vnk-r',
      name: 'روتر ونک',
      kind: 'router',
      parentId: 'st-thr-vnk',
      ip: '10.20.11.1',
      type: 'روتر',
      vendor: 'Cisco',
      model: 'ISR 1111',
      location: 'اتاق ارتباطات، رک ۱',
    }),
    dev({
      id: 'dev-vnk-sw',
      name: 'سوئیچ ونک',
      kind: 'switch',
      parentId: 'st-thr-vnk',
      ip: '10.20.11.2',
      type: 'سوئیچ',
      vendor: 'Cisco',
      model: 'Catalyst 1000',
      location: 'اتاق ارتباطات، رک ۱',
    }),
    dev({
      id: 'dev-vnk-fw',
      name: 'فایروال ونک',
      kind: 'firewall',
      parentId: 'st-thr-vnk',
      ip: '10.20.11.3',
      type: 'فایروال',
      vendor: 'Fortinet',
      model: 'FortiGate 40F',
      location: 'اتاق ارتباطات، رک ۱',
    }),
    dev({
      id: 'dev-vnk-ap',
      name: 'نقطهٔ دسترسی ونک',
      kind: 'access-point',
      parentId: 'st-thr-vnk',
      ip: '10.20.11.21',
      type: 'دسترسی بی‌سیم',
      vendor: 'Ubiquiti',
      model: 'U6-Lite',
      location: 'سالن انتظار، سقف',
    }),

    /* شبکهٔ داخلی ایستگاه تجریش */
    dev({
      id: 'dev-tjr-r',
      name: 'روتر تجریش',
      kind: 'router',
      parentId: 'st-thr-tjr',
      ip: '10.20.12.1',
      type: 'روتر',
      vendor: 'MikroTik',
      model: 'RB4011',
      location: 'اتاق ارتباطات، رک ۱',
    }),
    dev({
      id: 'dev-tjr-ap',
      name: 'نقطهٔ دسترسی تجریش',
      kind: 'access-point',
      parentId: 'st-thr-tjr',
      ip: '10.20.12.11',
      type: 'دسترسی بی‌سیم',
      vendor: 'Ubiquiti',
      model: 'U6-Lite',
      location: 'طبقهٔ همکف، سقف',
    }),

    /* شبکهٔ داخلی مرکز تجمع مشهد */
    dev({
      id: 'dev-mhd-core',
      name: 'روتر هستهٔ مشهد',
      kind: 'router',
      parentId: 'agg-mhd-c',
      ip: '10.30.1.1',
      type: 'روتر',
      vendor: 'Cisco',
      model: 'ASR 1001-X',
      location: 'سالن اصلی، رک ۱',
    }),
    dev({
      id: 'dev-mhd-sw',
      name: 'سوئیچ تجمیع مشهد',
      kind: 'switch',
      parentId: 'agg-mhd-c',
      ip: '10.30.1.2',
      type: 'سوئیچ',
      vendor: 'Cisco',
      model: 'Catalyst 9300',
      location: 'سالن اصلی، رک ۲',
    }),
    dev({
      id: 'dev-mhd-fw',
      name: 'فایروال مشهد',
      kind: 'firewall',
      parentId: 'agg-mhd-c',
      ip: '10.30.1.3',
      type: 'فایروال',
      vendor: 'Fortinet',
      model: 'FortiGate 100F',
      location: 'سالن اصلی، رک ۱',
    }),
    dev({
      id: 'dev-mhd-ap',
      name: 'نقطهٔ دسترسی حرم',
      kind: 'access-point',
      parentId: 'agg-mhd-c',
      ip: '10.30.1.21',
      status: 'warning',
      type: 'دسترسی بی‌سیم',
      vendor: 'Ubiquiti',
      model: 'U6-Pro',
      location: 'صحن اصلی، سقف',
      meta: { 'کلاینت متصل': 38 },
    }),

    /* شبکهٔ داخلی ایستگاه حرم */
    dev({
      id: 'dev-hrm-r',
      name: 'روتر حرم',
      kind: 'router',
      parentId: 'st-mhd-hrm',
      ip: '10.30.11.1',
      type: 'روتر',
      vendor: 'Cisco',
      model: 'ISR 1111',
      location: 'اتاق ارتباطات، رک ۱',
    }),
    dev({
      id: 'dev-hrm-sw',
      name: 'سوئیچ حرم',
      kind: 'switch',
      parentId: 'st-mhd-hrm',
      ip: '10.30.11.2',
      type: 'سوئیچ',
      vendor: 'Cisco',
      model: 'Catalyst 1000',
      location: 'اتاق ارتباطات، رک ۱',
    }),

    /* شبکهٔ داخلی ایستگاه وکیل‌آباد */
    dev({
      id: 'dev-vkl-r',
      name: 'روتر وکیل‌آباد',
      kind: 'router',
      parentId: 'st-mhd-vkl',
      ip: '10.30.12.1',
      type: 'روتر',
      vendor: 'MikroTik',
      model: 'RB4011',
      location: 'اتاق ارتباطات، رک ۱',
    }),
    dev({
      id: 'dev-vkl-sw',
      name: 'سوئیچ وکیل‌آباد',
      kind: 'switch',
      parentId: 'st-mhd-vkl',
      ip: '10.30.12.2',
      type: 'سوئیچ',
      vendor: 'Cisco',
      model: 'Catalyst 1000',
      location: 'اتاق ارتباطات، رک ۱',
    }),

    /* شبکهٔ داخلی مرکز تجمع اصفهان */
    dev({
      id: 'dev-isf-core',
      name: 'روتر هستهٔ اصفهان',
      kind: 'router',
      parentId: 'agg-isf-c',
      ip: '10.40.1.1',
      status: 'warning',
      type: 'روتر',
      vendor: 'Cisco',
      model: 'ASR 1001-X',
      location: 'سالن اصلی، رک ۱',
      meta: { 'تأخیر میانگین': '۱۸ میلی‌ثانیه' },
    }),
    dev({
      id: 'dev-isf-sw',
      name: 'سوئیچ تجمیع اصفهان',
      kind: 'switch',
      parentId: 'agg-isf-c',
      ip: '10.40.1.2',
      type: 'سوئیچ',
      vendor: 'Cisco',
      model: 'Catalyst 9300',
      location: 'سالن اصلی، رک ۲',
    }),
    dev({
      id: 'dev-isf-fw',
      name: 'فایروال اصفهان',
      kind: 'firewall',
      parentId: 'agg-isf-c',
      ip: '10.40.1.3',
      type: 'فایروال',
      vendor: 'Fortinet',
      model: 'FortiGate 60F',
      location: 'سالن اصلی، رک ۱',
    }),

    /* شبکهٔ داخلی ایستگاه چهارباغ */
    dev({
      id: 'dev-chb-r',
      name: 'روتر چهارباغ',
      kind: 'router',
      parentId: 'st-isf-chb',
      ip: '10.40.11.1',
      status: 'warning',
      type: 'روتر',
      vendor: 'MikroTik',
      model: 'RB4011',
      location: 'اتاق ارتباطات، رک ۱',
    }),
    dev({
      id: 'dev-chb-srv',
      name: 'سرور آرشیو چهارباغ',
      kind: 'server',
      parentId: 'st-isf-chb',
      ip: '10.40.11.10',
      type: 'سرور',
      vendor: 'Dell',
      model: 'PowerEdge R450',
      location: 'اتاق ارتباطات، رک ۲',
    }),

    /* شبکهٔ داخلی ایستگاه حافظیه */
    dev({
      id: 'dev-hfz-r',
      name: 'روتر حافظیه',
      kind: 'router',
      parentId: 'st-shz-hfz',
      ip: '10.60.11.1',
      type: 'روتر',
      vendor: 'Cisco',
      model: 'ISR 1111',
      location: 'اتاق ارتباطات، رک ۱',
    }),
    dev({
      id: 'dev-hfz-sw',
      name: 'سوئیچ حافظیه',
      kind: 'switch',
      parentId: 'st-shz-hfz',
      ip: '10.60.11.2',
      type: 'سوئیچ',
      vendor: 'Cisco',
      model: 'Catalyst 1000',
      location: 'اتاق ارتباطات، رک ۱',
    }),
    dev({
      id: 'dev-hfz-srv',
      name: 'سرور گزارش‌های حافظیه',
      kind: 'server',
      parentId: 'st-shz-hfz',
      ip: '10.60.11.10',
      type: 'سرور',
      vendor: 'Dell',
      model: 'PowerEdge R450',
      location: 'اتاق ارتباطات، رک ۲',
    }),

    /* شبکهٔ داخلی ایستگاه معالی‌آباد */
    dev({
      id: 'dev-mla-r',
      name: 'روتر معالی‌آباد',
      kind: 'router',
      parentId: 'st-shz-mla',
      ip: '10.60.12.1',
      status: 'warning',
      type: 'روتر',
      vendor: 'MikroTik',
      model: 'RB4011',
      location: 'اتاق ارتباطات، رک ۱',
      meta: { 'افت بسته': '۲٫۱٪' },
    }),
    dev({
      id: 'dev-mla-ap',
      name: 'نقطهٔ دسترسی معالی‌آباد',
      kind: 'access-point',
      parentId: 'st-shz-mla',
      ip: '10.60.12.11',
      type: 'دسترسی بی‌سیم',
      vendor: 'Ubiquiti',
      model: 'U6-Lite',
      location: 'طبقهٔ همکف، سقف',
    }),

    /* شبکهٔ داخلی مرکز تجمع تبریز */
    dev({
      id: 'dev-tbz-core',
      name: 'روتر هستهٔ تبریز',
      kind: 'router',
      parentId: 'agg-tbz-c',
      ip: '10.50.1.1',
      type: 'روتر',
      vendor: 'Cisco',
      model: 'ISR 4451',
      location: 'سالن اصلی، رک ۱',
    }),
    dev({
      id: 'dev-tbz-sw',
      name: 'سوئیچ تجمیع تبریز',
      kind: 'switch',
      parentId: 'agg-tbz-c',
      ip: '10.50.1.2',
      type: 'سوئیچ',
      vendor: 'Cisco',
      model: 'Catalyst 9300',
      location: 'سالن اصلی، رک ۲',
    }),

    /* شبکهٔ داخلی ایستگاه ولیعصر (قطع) */
    dev({
      id: 'dev-vls-r',
      name: 'روتر ولیعصر',
      kind: 'router',
      parentId: 'st-tbz-vls',
      ip: '10.50.11.1',
      status: 'offline',
      type: 'روتر',
      vendor: 'MikroTik',
      model: 'RB4011',
      location: 'اتاق ارتباطات، رک ۱',
    }),
    dev({
      id: 'dev-vls-sw',
      name: 'سوئیچ ولیعصر',
      kind: 'switch',
      parentId: 'st-tbz-vls',
      ip: '10.50.11.2',
      status: 'offline',
      type: 'سوئیچ',
      vendor: 'Cisco',
      model: 'Catalyst 1000',
      location: 'اتاق ارتباطات، رک ۱',
    }),
  ];

  /* خطوط بین‌شهری — نمای سراسری فقط همین‌ها را دارد تا شلوغ نشود */
  const edges: TopologyEdgeModel[] = [
    edge('e-thr-mhd', 'city-thr', 'city-mhd', 'fiber', {
      capacityMbps: 10000,
      latencyMs: 12,
      label: 'مدار DWDM',
      description: 'ستون فقرات شرق کشور روی فیبر تاریک',
    }),
    edge('e-thr-isf', 'city-thr', 'city-isf', 'fiber', {
      capacityMbps: 10000,
      latencyMs: 8,
      label: 'مدار DWDM',
    }),
    edge('e-thr-shz', 'city-thr', 'city-shz', 'fiber', { capacityMbps: 10000, latencyMs: 14 }),
    edge('e-thr-tbz', 'city-thr', 'city-tbz', 'fiber', { capacityMbps: 10000, latencyMs: 10 }),
    edge('e-mhd-tbz', 'city-mhd', 'city-tbz', 'wireless', {
      capacityMbps: 2000,
      latencyMs: 22,
      label: 'رادیو پشتیبان',
      description: 'لینک رادیویی نقطه‌به‌نقطهٔ شمال‌شرق',
    }),
    edge('e-isf-shz', 'city-isf', 'city-shz', 'wireless', {
      capacityMbps: 1000,
      latencyMs: 26,
      label: 'رادیو پشتیبان',
      state: 'degraded',
      description: 'کیفیت سیگنال رادیویی پایین‌تر از حد انتظار',
    }),
    edge('e-mhd-shz', 'city-mhd', 'city-shz', 'vpn', {
      capacityMbps: 500,
      latencyMs: 38,
      label: 'تونل منطقی',
      description: 'تونل IPSec پشتیبان برای مدیریت مرکزی',
    }),

    /* لینک‌های درون تهران */
    edge('e-thr-n-city', 'city-thr', 'agg-thr-n', 'fiber', { capacityMbps: 10000, latencyMs: 3 }),
    edge('e-thr-s-city', 'city-thr', 'agg-thr-s', 'fiber', { capacityMbps: 10000, latencyMs: 3 }),
    edge('e-thr-agg-ring', 'agg-thr-n', 'agg-thr-s', 'fiber', {
      capacityMbps: 40000,
      latencyMs: 1,
      label: 'حلقهٔ شهری',
    }),
    edge('e-thr-vnk-n', 'agg-thr-n', 'st-thr-vnk', 'fiber', { capacityMbps: 1000, latencyMs: 2 }),
    edge('e-thr-vnk-s', 'agg-thr-s', 'st-thr-vnk', 'vpn', {
      capacityMbps: 200,
      latencyMs: 6,
      label: 'تونل پشتیبان',
      description: 'مسیر مدیریتی جایگزین روی اینترنت سازمانی',
    }),
    edge('e-thr-tjr-city', 'city-thr', 'st-thr-tjr', 'wireless', {
      capacityMbps: 300,
      latencyMs: 9,
      label: 'بک‌هال رادیویی',
    }),
    edge('e-thr-vnk-tjr', 'st-thr-vnk', 'st-thr-tjr', 'ethernet', { capacityMbps: 1000, latencyMs: 1 }),

    /* لینک‌های درون مشهد */
    edge('e-mhd-c-city', 'city-mhd', 'agg-mhd-c', 'fiber', { capacityMbps: 10000, latencyMs: 3 }),
    edge('e-mhd-hrm-city', 'city-mhd', 'st-mhd-hrm', 'fiber', { capacityMbps: 1000, latencyMs: 2 }),
    edge('e-mhd-hrm-agg', 'agg-mhd-c', 'st-mhd-hrm', 'fiber', { capacityMbps: 1000, latencyMs: 1 }),
    edge('e-mhd-vkl-city', 'city-mhd', 'st-mhd-vkl', 'wireless', { capacityMbps: 300, latencyMs: 7 }),
    edge('e-mhd-hrm-vkl', 'st-mhd-hrm', 'st-mhd-vkl', 'wireless', {
      capacityMbps: 200,
      latencyMs: 4,
      state: 'degraded',
    }),

    /* لینک‌های درون اصفهان */
    edge('e-isf-c-city', 'city-isf', 'agg-isf-c', 'fiber', {
      capacityMbps: 10000,
      latencyMs: 4,
      state: 'degraded',
    }),
    edge('e-isf-chb-city', 'city-isf', 'st-isf-chb', 'ethernet', { capacityMbps: 1000, latencyMs: 2 }),
    edge('e-isf-chb-agg', 'agg-isf-c', 'st-isf-chb', 'fiber', { capacityMbps: 1000, latencyMs: 1 }),

    /* لینک‌های درون شیراز */
    edge('e-shz-hfz-city', 'city-shz', 'st-shz-hfz', 'fiber', { capacityMbps: 1000, latencyMs: 3 }),
    edge('e-shz-mla-city', 'city-shz', 'st-shz-mla', 'wireless', { capacityMbps: 300, latencyMs: 8 }),
    edge('e-shz-hfz-mla', 'st-shz-hfz', 'st-shz-mla', 'fiber', {
      capacityMbps: 1000,
      latencyMs: 5,
      state: 'degraded',
    }),

    /* لینک‌های درون تبریز */
    edge('e-tbz-c-city', 'city-tbz', 'agg-tbz-c', 'fiber', { capacityMbps: 10000, latencyMs: 4 }),
    edge('e-tbz-vls-city', 'city-tbz', 'st-tbz-vls', 'ethernet', {
      capacityMbps: 1000,
      latencyMs: 2,
      state: 'down',
      description: 'قطع کابل مسی؛ تیم عملیات در محل',
    }),
    edge('e-tbz-vls-agg', 'agg-tbz-c', 'st-tbz-vls', 'fiber', { capacityMbps: 1000, latencyMs: 2, state: 'down' }),

    /* شبکهٔ داخلی مرکز تجمع تهران شمال */
    edge('e-af-thr-n-uplink', 'agg-thr-n', 'dev-thr-n-core', 'fiber', {
      capacityMbps: 40000,
      latencyMs: 1,
      label: 'Uplink 40G',
    }),
    edge('e-af-thr-n-core-fw', 'dev-thr-n-core', 'dev-thr-n-fw', 'fiber', { capacityMbps: 10000, latencyMs: 1 }),
    edge('e-af-thr-n-core-agg', 'dev-thr-n-core', 'dev-thr-n-agg', 'fiber', {
      capacityMbps: 40000,
      latencyMs: 1,
      label: 'Po40',
    }),
    edge('e-af-thr-n-agg-acc', 'dev-thr-n-agg', 'dev-thr-n-acc', 'ethernet', { capacityMbps: 1000, latencyMs: 1 }),
    edge('e-af-thr-n-agg-srv', 'dev-thr-n-agg', 'dev-thr-n-srv', 'ethernet', { capacityMbps: 1000, latencyMs: 1 }),
    edge('e-af-thr-n-acc-ap', 'dev-thr-n-acc', 'dev-thr-n-ap', 'wireless', {
      capacityMbps: 300,
      latencyMs: 3,
      label: 'بک‌هال AP',
    }),
    edge('e-af-thr-n-core-bkp', 'dev-thr-n-core', 'dev-thr-n-bkp', 'vpn', {
      capacityMbps: 200,
      latencyMs: 4,
      state: 'down',
      label: 'تونل پشتیبان',
      description: 'تونل IPSec ذخیره‌سازی؛ سرور مقصد خاموش است',
    }),

    /* شبکهٔ داخلی تهران جنوب */
    edge('e-af-thr-s-uplink', 'agg-thr-s', 'dev-thr-s-core', 'fiber', { capacityMbps: 40000, latencyMs: 1 }),
    edge('e-af-thr-s-core-sw', 'dev-thr-s-core', 'dev-thr-s-sw', 'fiber', { capacityMbps: 10000, latencyMs: 1 }),
    edge('e-af-thr-s-core-fw', 'dev-thr-s-core', 'dev-thr-s-fw', 'fiber', { capacityMbps: 1000, latencyMs: 1 }),

    /* شبکهٔ داخلی ونک */
    edge('e-af-vnk-uplink', 'st-thr-vnk', 'dev-vnk-r', 'fiber', { capacityMbps: 1000, latencyMs: 1 }),
    edge('e-af-vnk-r-fw', 'dev-vnk-r', 'dev-vnk-fw', 'fiber', { capacityMbps: 1000, latencyMs: 1 }),
    edge('e-af-vnk-r-sw', 'dev-vnk-r', 'dev-vnk-sw', 'ethernet', { capacityMbps: 1000, latencyMs: 1 }),
    edge('e-af-vnk-sw-ap', 'dev-vnk-sw', 'dev-vnk-ap', 'ethernet', { capacityMbps: 1000, latencyMs: 1 }),

    /* شبکهٔ داخلی تجریش */
    edge('e-af-tjr-uplink', 'st-thr-tjr', 'dev-tjr-r', 'wireless', {
      capacityMbps: 300,
      latencyMs: 2,
      label: 'بک‌هال',
    }),
    edge('e-af-tjr-r-ap', 'dev-tjr-r', 'dev-tjr-ap', 'ethernet', { capacityMbps: 1000, latencyMs: 1 }),

    /* شبکهٔ داخلی مشهد */
    edge('e-af-mhd-uplink', 'agg-mhd-c', 'dev-mhd-core', 'fiber', { capacityMbps: 40000, latencyMs: 1 }),
    edge('e-af-mhd-core-fw', 'dev-mhd-core', 'dev-mhd-fw', 'fiber', { capacityMbps: 10000, latencyMs: 1 }),
    edge('e-af-mhd-core-sw', 'dev-mhd-core', 'dev-mhd-sw', 'fiber', { capacityMbps: 40000, latencyMs: 1 }),
    edge('e-af-mhd-sw-ap', 'dev-mhd-sw', 'dev-mhd-ap', 'wireless', { capacityMbps: 300, latencyMs: 3 }),

    /* ایستگاه حرم */
    edge('e-af-hrm-uplink', 'st-mhd-hrm', 'dev-hrm-r', 'fiber', { capacityMbps: 1000, latencyMs: 1 }),
    edge('e-af-hrm-r-sw', 'dev-hrm-r', 'dev-hrm-sw', 'ethernet', { capacityMbps: 1000, latencyMs: 1 }),

    /* ایستگاه وکیل‌آباد */
    edge('e-af-vkl-uplink', 'st-mhd-vkl', 'dev-vkl-r', 'wireless', { capacityMbps: 300, latencyMs: 2 }),
    edge('e-af-vkl-r-sw', 'dev-vkl-r', 'dev-vkl-sw', 'ethernet', { capacityMbps: 1000, latencyMs: 1 }),

    /* شبکهٔ داخلی اصفهان */
    edge('e-af-isf-uplink', 'agg-isf-c', 'dev-isf-core', 'fiber', {
      capacityMbps: 40000,
      latencyMs: 2,
      state: 'degraded',
    }),
    edge('e-af-isf-core-fw', 'dev-isf-core', 'dev-isf-fw', 'fiber', { capacityMbps: 10000, latencyMs: 1 }),
    edge('e-af-isf-core-sw', 'dev-isf-core', 'dev-isf-sw', 'fiber', { capacityMbps: 40000, latencyMs: 1 }),

    /* ایستگاه چهارباغ */
    edge('e-af-chb-uplink', 'st-isf-chb', 'dev-chb-r', 'ethernet', {
      capacityMbps: 1000,
      latencyMs: 1,
      state: 'degraded',
    }),
    edge('e-af-chb-r-srv', 'dev-chb-r', 'dev-chb-srv', 'ethernet', { capacityMbps: 1000, latencyMs: 1 }),

    /* ایستگاه حافظیه */
    edge('e-af-hfz-uplink', 'st-shz-hfz', 'dev-hfz-r', 'fiber', { capacityMbps: 1000, latencyMs: 1 }),
    edge('e-af-hfz-r-sw', 'dev-hfz-r', 'dev-hfz-sw', 'ethernet', { capacityMbps: 1000, latencyMs: 1 }),
    edge('e-af-hfz-sw-srv', 'dev-hfz-sw', 'dev-hfz-srv', 'ethernet', { capacityMbps: 1000, latencyMs: 1 }),

    /* ایستگاه معالی‌آباد */
    edge('e-af-mla-uplink', 'st-shz-mla', 'dev-mla-r', 'wireless', { capacityMbps: 300, latencyMs: 3 }),
    edge('e-af-mla-r-ap', 'dev-mla-r', 'dev-mla-ap', 'ethernet', { capacityMbps: 1000, latencyMs: 1 }),

    /* شبکهٔ داخلی تبریز */
    edge('e-af-tbz-uplink', 'agg-tbz-c', 'dev-tbz-core', 'fiber', { capacityMbps: 40000, latencyMs: 1 }),
    edge('e-af-tbz-core-sw', 'dev-tbz-core', 'dev-tbz-sw', 'fiber', { capacityMbps: 40000, latencyMs: 1 }),

    /* ایستگاه ولیعصر — کل مسیر قطع است */
    edge('e-af-vls-uplink', 'st-tbz-vls', 'dev-vls-r', 'ethernet', {
      capacityMbps: 1000,
      latencyMs: 2,
      state: 'down',
    }),
    edge('e-af-vls-r-sw', 'dev-vls-r', 'dev-vls-sw', 'ethernet', { capacityMbps: 1000, latencyMs: 1, state: 'down' }),
  ];

  /* شهرِ هر گره از زنجیرهٔ والدها استخراج می‌شود تا دوبار نوشته نشود */
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const node of nodes) {
    if (node.kind === 'city') {
      node.cityId = node.id;
      continue;
    }
    let parent = node.parentId ? byId.get(node.parentId) : null;
    let guard = 0;
    while (parent && parent.kind !== 'city' && guard++ < 16) {
      parent = parent.parentId ? byId.get(parent.parentId) : null;
    }
    node.cityId = parent?.kind === 'city' ? parent.id : null;
  }

  return { nodes, edges, source: 'sample' };
}
