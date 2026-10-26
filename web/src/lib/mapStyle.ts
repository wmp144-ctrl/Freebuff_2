/**
 * استایل کارتوگرافی کاشی‌های برداری آفلاین (طرح OpenMapTiles).
 *
 * پیش‌تر هر لایهٔ برداری سه بار (fill/line/circle) با یک رنگ تصادفی رسم می‌شد؛
 * نتیجه چیزی جز انبوهی از نقطه و خط نبود. این‌جا برای هر لایه، نوع هندسه و
 * ویژگی‌های واقعی‌اش (class، admin_level، brunnel، …) استفاده می‌شود تا نقشه
 * شبیه یک نقشهٔ خواناست: آب آبی، پارک سبز، شبکهٔ راه با سلسله‌مراتب و حاشیه،
 * ساختمان خاکستری و مرز خط‌چین.
 *
 * برچسب‌های متنی (نام خیابان‌ها و اماکن) با فونت SDF محلی رسم می‌شوند؛ فایل‌های
 * گلیف در `web/public/glyphs` ساخته شده‌اند و استایل از همان‌جا می‌خواند، پس
 * نقشه برای نوشتن فارسی هم آفلاین می‌ماند. نام شهرها/استان‌ها را همچنان
 * لایهٔ برچسب HTML در MapPage می‌نویسد (زیر نشانگرهای تجهیزات).
 */
import type { MapLayer } from './types';

const SOURCE = 'netwatch';

/** شناسهٔ لایهٔ نامرئیای که فقط برای یافتن نقاط نام‌ها استفاده می‌شود. */
export const LABEL_ANCHOR_LAYER = 'label-anchor-place';

/**
 * فونت SDF برای برچسب‌های نقشه. فایل‌های گلیف به‌صورت محلی در
 * `web/public/glyphs/<نام فونت>/<بازه>.pbf` ساخته شده‌اند تا نقشه کاملاً
 * آفلاین بماند. فونت باید حروف عربی/فارسی و اَشکال نمایشی (U+FE80…U+FEFC)
 * را داشته باشد، چون MapLibre حروف را پیش از رسم به اَشکال اتصال تبدیل می‌کند.
 */
export const LABEL_FONT = 'Vazirmatn';

/** ترجیح نام فارسی؛ در نبود آن از نام پیش‌فرض فایل استفاده می‌شود. */
const NAME_FIELD = ['coalesce', ['get', 'name:fa'], ['get', 'name']];

/** سبک مشترک برچسب‌های متنی روی بوم MapLibre. */
const labelPaint = {
  'text-color': '#33302a',
  'text-halo-color': 'rgba(255,255,255,0.92)',
  'text-halo-width': 1.4,
  'text-halo-blur': 0.3,
};

const C = {
  background: '#f4f1e9',
  landcover: {
    wood: '#c9dfb4',
    grass: '#dbeac6',
    farmland: '#eef0d4',
    sand: '#f2e8ce',
    ice: '#e9f3f8',
    wetland: '#cfe6dd',
    rock: '#e6e2d9',
  },
  landuse: '#e8e4dc',
  park: '#d3e7bc',
  parkLine: '#bcd7a2',
  water: '#a8cbe4',
  waterLine: '#93bbd9',
  boundary: '#a79dc0',
  aeroway: '#dfe3e6',
  building: '#ddd5c7',
  buildingLine: '#cec3b1',
  track: '#c4af95',
  rail: '#9c9c9c',
  fallbackFill: '#cfd6de',
  fallbackLine: '#b3bcc7',
};

/** درون‌یابی بر اساس زوم؛ آرگومان‌ها جفت‌های (زوم، مقدار) هستند. */
const byZoom = (stops: number[]) => ['interpolate', ['linear'], ['zoom'], ...stops];

/** زوم‌هایی که ضخامت راه برایشان تعریف شده است. */
const WIDTH_ZOOMS = [10, 13, 16, 19];
const widths = (w: number[]) => [
  'interpolate',
  ['linear'],
  ['zoom'],
  8,
  w[0] * 0.7,
  ...WIDTH_ZOOMS.flatMap((z, i) => [z, w[i]]),
];

type StyleLayer = Record<string, unknown>;

/** کلاس‌های راه از کم‌اهمیت‌ترین به مهم‌ترین؛ ترتیب رسم هم همین است. */
type RoadTier = {
  id: string;
  classes: string[];
  fill: string;
  casing: string;
  /** ضخامت خط در زوم‌های ۱۰، ۱۳، ۱۶ و ۱۹ */
  width: number[];
  dash?: number[];
  /** مسیرهای باریک حاشیه نمی‌گیرند تا خط‌چینشان با خط زیرین پر نشود. */
  noCasing?: boolean;
};

const ROADS: RoadTier[] = [
  {
    id: 'path',
    classes: ['path', 'footway', 'pedestrian', 'steps', 'track', 'cycleway', 'bridleway', 'ski'],
    fill: C.track,
    casing: C.track,
    width: [0.5, 0.8, 1.2, 2],
    dash: [1.5, 1.2],
    noCasing: true,
  },
  { id: 'service', classes: ['service'], fill: '#ffffff', casing: '#d9d2c7', width: [0.8, 1.2, 2.2, 4] },
  { id: 'minor', classes: ['minor'], fill: '#ffffff', casing: '#d2cabd', width: [0.8, 1.4, 3, 6] },
  { id: 'tertiary', classes: ['tertiary'], fill: '#ffffff', casing: '#d0c6b6', width: [1, 1.8, 3.8, 7.5] },
  { id: 'secondary', classes: ['secondary'], fill: '#fdfaf3', casing: '#d3c3a9', width: [1.2, 2.2, 4.6, 9] },
  { id: 'primary', classes: ['primary'], fill: '#fbd9ac', casing: '#dda964', width: [1.4, 2.6, 5.4, 10.5] },
  { id: 'trunk', classes: ['trunk'], fill: '#f8c69b', casing: '#d98f58', width: [1.6, 3, 6.2, 12] },
  { id: 'motorway', classes: ['motorway'], fill: '#f6b78f', casing: '#d47f47', width: [1.8, 3.4, 7, 13] },
];

/** سازه‌های در دست ساخت هم مثل راه باز همان کلاس رسم می‌شوند. */
const withConstruction = (classes: string[]) => [
  ...classes,
  ...classes.filter((c) => c !== 'service' && c !== 'path').map((c) => `${c}_construction`),
];

const casingWidth = (width: number[]) => width.map((w) => w + Math.max(1.2, w * 0.55));

/** رنگ حاشیهٔ راه برای تونل‌ها محو می‌شود تا پشت زمین گم نشود. */
const tunnelOpacity = ['case', ['==', ['get', 'brunnel'], 'tunnel'], 0.45, 1] as unknown[];

function roadLayers(tier: RoadTier): StyleLayer[] {
  const filter = ['in', ['get', 'class'], ['literal', withConstruction(tier.classes)]];
  const common = { source: SOURCE, 'source-layer': 'transportation', filter };
  const minzoom = tier.id === 'path' ? 13 : 6;
  const layers: StyleLayer[] = [];
  if (!tier.noCasing) {
    layers.push({
      id: `road-casing-${tier.id}`,
      type: 'line',
      ...common,
      minzoom,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': tier.casing,
        'line-width': widths(casingWidth(tier.width)),
        'line-opacity': tunnelOpacity,
      },
    });
  }
  layers.push({
    id: `road-${tier.id}`,
    type: 'line',
    ...common,
    minzoom: tier.id === 'path' ? 13 : 5,
    layout: { 'line-cap': tier.dash ? 'butt' : 'round', 'line-join': 'round' },
    paint: {
      'line-color': tier.fill,
      'line-width': widths(tier.width),
      'line-opacity': tunnelOpacity,
      ...(tier.dash ? { 'line-dasharray': tier.dash } : {}),
    },
  });
  return layers;
}

/**
 * ساخت استایل MapLibre برای یک لایهٔ MBTiles برداری.
 * تنها لایه‌هایی استایل می‌گیرند که واقعاً در فایل وجود دارند؛ هر لایهٔ ناشناخته
 * با استایل خنثی و کم‌رنگ در پایین نقشه رسم می‌شود تا روی نقشهٔ اصلی را نپوشاند.
 */
export function buildVectorStyle(layer: MapLayer) {
  const vectorLayers = (layer.fileInfo?.vectorLayers ?? []).map((v) => String(v.id));
  const has = (id: string) => vectorLayers.includes(id);
  const minzoom = Number(layer.fileInfo?.minzoom ?? layer.min_zoom ?? 0);
  const maxzoom = Number(layer.fileInfo?.maxzoom ?? layer.max_zoom ?? 14);

  const layers: StyleLayer[] = [
    { id: 'background', type: 'background', paint: { 'background-color': C.background } },
  ];

  const KNOWN = new Set([
    'water',
    'waterway',
    'landcover',
    'landuse',
    'park',
    'boundary',
    'aeroway',
    'transportation',
    'building',
    // لایه‌های فقط-برچسب: بدون فونت رسم نمی‌شوند و به‌جای نقطه‌های بی‌معنا نادیده گرفته می‌شوند.
    'place',
    'poi',
    'water_name',
    'transportation_name',
    'aerodrome_label',
    'mountain_peak',
    'housenumber',
  ]);

  // لایه‌های ناشناخته (فایل‌های تولیدشده با ابزارهای دیگر) با خاکستری کم‌رنگ،
  // پایین‌تر از همه‌چیز، تا ساختار نقشهٔ اصلی خوانا بماند.
  for (const id of vectorLayers.filter((v) => !KNOWN.has(v))) {
    layers.push({
      id: `fallback-fill-${id}`,
      type: 'fill',
      source: SOURCE,
      'source-layer': id,
      paint: { 'fill-color': C.fallbackFill, 'fill-opacity': 0.18 },
    });
    layers.push({
      id: `fallback-line-${id}`,
      type: 'line',
      source: SOURCE,
      'source-layer': id,
      paint: { 'line-color': C.fallbackLine, 'line-width': 0.6, 'line-opacity': 0.5 },
    });
  }

  if (has('landcover')) {
    const cover = (name: string, classes: string[], color: string) => ({
      id: `landcover-${name}`,
      type: 'fill',
      source: SOURCE,
      'source-layer': 'landcover',
      filter: ['in', ['get', 'class'], ['literal', classes]],
      paint: { 'fill-color': color, 'fill-opacity': 0.9 },
    });
    layers.push(cover('wood', ['wood', 'forest'], C.landcover.wood));
    layers.push(cover('grass', ['grass', 'meadow', 'scrub'], C.landcover.grass));
    layers.push(cover('farmland', ['farmland'], C.landcover.farmland));
    layers.push(cover('sand', ['sand', 'beach'], C.landcover.sand));
    layers.push(cover('ice', ['ice', 'glacier'], C.landcover.ice));
    layers.push(cover('wetland', ['wetland', 'marsh', 'swamp'], C.landcover.wetland));
    layers.push(cover('rock', ['rock', 'scree'], C.landcover.rock));
  }

  if (has('landuse')) {
    layers.push({
      id: 'landuse-built',
      type: 'fill',
      source: SOURCE,
      'source-layer': 'landuse',
      filter: ['in', ['get', 'class'], ['literal', ['residential', 'suburb', 'neighbourhood', 'quarter', 'commercial', 'retail', 'industrial', 'railway', 'garage', 'cemetery', 'military', 'school', 'hospital', 'university', 'stadium', 'parking', 'airport']]],
      paint: { 'fill-color': C.landuse, 'fill-opacity': 0.55 },
    });
  }

  if (has('park')) {
    layers.push({
      id: 'park',
      type: 'fill',
      source: SOURCE,
      'source-layer': 'park',
      paint: { 'fill-color': C.park, 'fill-opacity': 0.75, 'fill-outline-color': C.parkLine },
    });
  }

  if (has('water')) {
    layers.push({
      id: 'water',
      type: 'fill',
      source: SOURCE,
      'source-layer': 'water',
      filter: ['!=', ['get', 'class'], 'swimming_pool'],
      paint: { 'fill-color': C.water, 'fill-opacity': 1 },
    });
    layers.push({
      id: 'water-outline',
      type: 'line',
      source: SOURCE,
      'source-layer': 'water',
      filter: ['!=', ['get', 'class'], 'swimming_pool'],
      minzoom: 10,
      paint: { 'line-color': C.waterLine, 'line-width': byZoom([10, 0.4, 16, 1]) },
    });
  }

  if (has('waterway')) {
    layers.push({
      id: 'waterway',
      type: 'line',
      source: SOURCE,
      'source-layer': 'waterway',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': C.water,
        'line-width': byZoom([8, 0.4, 13, 1.2, 18, 3.5]),
      },
    });
  }

  if (has('aeroway')) {
    layers.push({
      id: 'aeroway',
      type: 'fill',
      source: SOURCE,
      'source-layer': 'aeroway',
      minzoom: 9,
      filter: ['in', ['get', 'class'], ['literal', ['runway', 'taxiway', 'apron', 'helipad']]],
      paint: { 'fill-color': C.aeroway, 'fill-opacity': 0.9 },
    });
  }

  if (has('boundary')) {
    layers.push({
      id: 'boundary-country',
      type: 'line',
      source: SOURCE,
      'source-layer': 'boundary',
      filter: ['<=', ['to-number', ['get', 'admin_level'], 99], 2],
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': C.boundary,
        'line-width': byZoom([2, 0.7, 10, 1.2, 16, 2.4]),
        'line-dasharray': [2.4, 1.4],
      },
    });
    layers.push({
      id: 'boundary-province',
      type: 'line',
      source: SOURCE,
      'source-layer': 'boundary',
      minzoom: 5,
      filter: ['all', ['>', ['to-number', ['get', 'admin_level'], 99], 2], ['<=', ['to-number', ['get', 'admin_level'], 99], 4]],
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': C.boundary,
        'line-width': byZoom([5, 0.5, 12, 1, 16, 1.6]),
        'line-opacity': 0.8,
        'line-dasharray': [2, 1.8],
      },
    });
  }

  if (has('transportation')) {
    // راه‌آهن پیش از راه‌ها رسم می‌شود تا زیر آن‌ها بماند.
    layers.push({
      id: 'rail',
      type: 'line',
      source: SOURCE,
      'source-layer': 'transportation',
      minzoom: 8,
      filter: ['in', ['get', 'class'], ['literal', ['rail', 'transit']]],
      paint: {
        'line-color': C.rail,
        'line-width': byZoom([8, 0.6, 14, 1.4, 18, 2.2]),
        'line-dasharray': [3, 2],
        'line-opacity': 0.85,
      },
    });
    for (const tier of ROADS) layers.push(...roadLayers(tier));
  }

  // نقطهٔ لنگر برچسب‌ها: متن در MapLibre بدون فونت SDF رسم نمی‌شود، پس نام
  // شهرها با یک لایهٔ نامرئی قابل پرس‌وجو می‌شود و به‌صورت HTML روی نقشه
  // نوشته می‌شود (MapPage). شعاع غیرصفر لازم است تا MapLibre آن را رندر کند.
  if (has('place')) {
    layers.push({
      id: LABEL_ANCHOR_LAYER,
      type: 'circle',
      source: SOURCE,
      'source-layer': 'place',
      paint: { 'circle-radius': 0.4, 'circle-color': '#000000', 'circle-opacity': 0.01 },
    });
  }

  // برچسب خیابان/کوچه: متن روی خط رسم می‌شود تا جهت گذر خوانا بماند.
  if (has('transportation_name')) {
    layers.push({
      id: 'street-name',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'transportation_name',
      minzoom: 14,
      filter: ['any', ['has', 'name'], ['has', 'name:fa']],
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 320,
        'text-field': NAME_FIELD,
        'text-font': [LABEL_FONT],
        'text-size': byZoom([14, 10.5, 17, 12.5, 19, 14]),
        'text-padding': 2,
        'text-max-angle': 35,
        'text-rotation-alignment': 'map',
        'text-pitch-alignment': 'viewport',
        'symbol-z-order': 'auto',
      },
      paint: labelPaint,
    });
  }

  // برچسب اماکن (POI): فقط نام‌دارها، با اولویت بر اساس rank تا در شلوغی
  // مهم‌ها زیر مهم‌ها گم نشوند.
  if (has('poi')) {
    layers.push({
      id: 'poi-name',
      type: 'symbol',
      source: SOURCE,
      'source-layer': 'poi',
      minzoom: 14,
      filter: ['any', ['has', 'name'], ['has', 'name:fa']],
      layout: {
        'text-field': NAME_FIELD,
        'text-font': [LABEL_FONT],
        'text-size': byZoom([14, 10.5, 17, 12, 19, 13.5]),
        'text-padding': 3,
        'text-anchor': 'center',
        'text-max-width': 8,
        'symbol-sort-key': ['to-number', ['get', 'rank'], 99],
      },
      paint: labelPaint,
    });
  }

  if (has('building')) {
    layers.push({
      id: 'building',
      type: 'fill',
      source: SOURCE,
      'source-layer': 'building',
      minzoom: 13,
      paint: {
        'fill-color': ['interpolate', ['linear'], ['zoom'], 13, '#ebe5db', 16, C.building],
        'fill-opacity': byZoom([12.5, 0.3, 15, 0.9]),
        'fill-outline-color': C.buildingLine,
      },
    });
  }

  return {
    version: 8,
    // گلیف‌های محلی: مسیر نسبی، مستقل از دامنه/پورت.
    glyphs: '/glyphs/{fontstack}/{range}.pbf',
    sources: {
      [SOURCE]: {
        type: 'vector' as const,
        // مسیر نسبی: مستقل از دامنه/پورت و همان کوکی نشست را می‌فرستد.
        tiles: [`/api/tiles/${layer.id}/{z}/{x}/{y}.pbf`],
        minzoom,
        maxzoom,
      },
    },
    layers,
  };
}
