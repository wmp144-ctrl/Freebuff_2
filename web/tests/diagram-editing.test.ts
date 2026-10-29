import test from 'node:test';
import assert from 'node:assert/strict';
import {
  alignNodes,
  copyToClipboard,
  deviceNodeNeedsSync,
  deviceNodeSyncPatch,
  distributeNodes,
  pasteFromClipboard,
} from '../src/lib/diagrams.ts';
import type { DiagramFlowNode } from '../src/lib/diagrams.ts';
import type { Device } from '../src/lib/types.ts';

function node(id: string, x: number, y: number, extra: Partial<DiagramFlowNode> = {}): DiagramFlowNode {
  return {
    id,
    type: 'device',
    position: { x, y },
    width: 100,
    height: 50,
    selected: true,
    data: { label: id },
    ...extra,
  } as DiagramFlowNode;
}

test('aligning selected nodes uses the bounding box of the selection', () => {
  const nodes = [node('a', 10, 40), node('b', 200, 10), node('c', 90, 300, { selected: false })];

  assert.deepEqual(
    alignNodes(nodes, 'left').map((n) => n.position),
    [
      { x: 10, y: 40 },
      { x: 10, y: 10 },
      { x: 90, y: 300 },
    ]
  );

  // لبهٔ مقابل: راست‌ترین لبه مبنا است (۲۰۰ + ۱۰۰).
  assert.equal(alignNodes(nodes, 'right')[0].position.x, 200);
  assert.equal(alignNodes(nodes, 'right')[1].position.x, 200);

  // وسطِ افقی و عمودی
  assert.equal(alignNodes(nodes, 'center-x')[0].position.x, 105);
  // وسطِ عمودی کادر محدودکنندهٔ دو جزء (۱۰ تا ۹۰) → ۵۰ منهای نصف ارتفاع
  assert.equal(alignNodes(nodes, 'center-y')[0].position.y, 25);

  // با کمتر از دو انتخاب، هیچ تغییری اعمال نمی‌شود.
  const single = [node('only', 5, 5)];
  assert.equal(alignNodes(single, 'left'), single);
});

test('distribution places the middle nodes at equal spacing', () => {
  const nodes = [node('a', 0, 0), node('b', 60, 0), node('c', 400, 0)];
  const distributed = distributeNodes(nodes, 'x');
  const xs = distributed.map((n) => n.position.x);
  assert.deepEqual(xs, [0, 200, 400]);
  // فاصلهٔ مرکزها یکنواخت است.
  const centers = distributed.map((n) => n.position.x + 50);
  assert.equal(centers[1] - centers[0], centers[2] - centers[1]);

  const vertical = distributeNodes([node('a', 0, 0), node('b', 0, 30), node('c', 0, 300)], 'y');
  assert.deepEqual(
    vertical.map((n) => n.position.y),
    [0, 150, 300]
  );
  // با دو جزء توزیع معنایی ندارد.
  const two = [node('a', 0, 0), node('b', 100, 0)];
  assert.equal(distributeNodes(two, 'x'), two);
});

test('copied nodes paste with fresh ids, an offset and rebuilt edges', () => {
  const a = node('a', 0, 0);
  const b = node('b', 200, 0);
  const edges = [
    { id: 'e1', type: 'diagram' as const, source: 'a', target: 'b', sourceHandle: 'right', targetHandle: 'left', data: { kind: 'fiber' as const, label: 'uplink' } },
    // ارتباط با یک جزء بیرون از انتخاب نباید کپی شود.
    { id: 'e2', type: 'diagram' as const, source: 'a', target: 'zzz', sourceHandle: 'right', targetHandle: 'left', data: { kind: 'copper' as const, label: '' } },
  ];

  assert.equal(copyToClipboard([a, b], edges), 2);
  const pasted = pasteFromClipboard(30);
  assert.ok(pasted);
  assert.equal(pasted!.nodes.length, 2);
  assert.equal(pasted!.edges.length, 1);
  // شناسه‌های تازه
  assert.ok(pasted!.nodes.every((n) => n.id !== 'a' && n.id !== 'b'));
  // جابه‌جایی نسبت به نسخهٔ اصلی
  assert.deepEqual(pasted!.nodes.map((n) => n.position), [
    { x: 30, y: 30 },
    { x: 230, y: 30 },
  ]);
  // انتخاب‌شده برای جابه‌جایی فوری
  assert.ok(pasted!.nodes.every((n) => n.selected));
  // ارتباط به شناسه‌های تازه اشاره می‌کند
  const ids = new Set(pasted!.nodes.map((n) => n.id));
  assert.ok(ids.has(pasted!.edges[0].source));
  assert.ok(ids.has(pasted!.edges[0].target));
  assert.equal(pasted!.edges[0].data?.label, 'uplink');
});

test('device sync refreshes identity fields and only replaces a default colour', () => {
  const device = {
    id: 7,
    name: 'سوئیچ تازه',
    ip: '10.9.9.9',
    deviceType: 'روتر',
    model: 'RB4011',
    serial: 'SN-9',
  } as Device;

  const defaultColor = deviceNodeSyncPatch(
    { label: 'قدیمی', deviceType: 'switch', color: '#2563eb', model: '', serial: '' },
    device
  );
  assert.equal(defaultColor.label, 'سوئیچ تازه');
  assert.equal(defaultColor.deviceType, 'router');
  assert.equal(defaultColor.ip, '10.9.9.9');
  assert.equal(defaultColor.model, 'RB4011');
  assert.equal(defaultColor.color, '#ea580c', 'رنگ پیش‌فرض نوع قبلی با نوع تازه عوض می‌شود');

  const customColor = deviceNodeSyncPatch({ label: 'قدیمی', deviceType: 'switch', color: '#123456' }, device);
  assert.equal(customColor.color, undefined, 'رنگ دستی کاربر دست‌نخورده می‌ماند');

  assert.equal(
    deviceNodeNeedsSync({ label: 'سوئیچ تازه', deviceType: 'router', ip: '10.9.9.9', model: 'RB4011' }, device),
    false
  );
  assert.equal(deviceNodeNeedsSync({ label: 'نام دیگر', deviceType: 'router', ip: '10.9.9.9' }, device), true);
});
