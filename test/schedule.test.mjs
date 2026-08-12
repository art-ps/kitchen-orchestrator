import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveServeDate, computeSchedule } from "../schedule.js";

const at = (h, m) => new Date(2026, 7, 12, h, m, 0, 0); // 12 августа 2026, локальное время

test("resolveServeDate: время впереди — сегодня", () => {
  assert.deepEqual(resolveServeDate("20:00", at(18, 0)), at(20, 0));
});

test("resolveServeDate: время прошло — завтра", () => {
  const d = resolveServeDate("08:00", at(18, 0));
  assert.deepEqual(d, new Date(2026, 7, 13, 8, 0, 0, 0));
});

test("resolveServeDate: ровно сейчас — завтра", () => {
  const d = resolveServeDate("18:00", at(18, 0));
  assert.deepEqual(d, new Date(2026, 7, 13, 18, 0, 0, 0));
});

test("computeSchedule: сортировка по старту, длинное — первым", () => {
  const { entries } = computeSchedule(
    [
      { id: "a", name: "картошка", minutes: 40 },
      { id: "b", name: "гусь", minutes: 180 },
    ],
    at(20, 0), at(10, 0),
  );
  assert.deepEqual(entries.map(e => e.id), ["b", "a"]);
  assert.deepEqual(entries[0].start, at(17, 0));
  assert.deepEqual(entries[1].start, at(19, 20));
});

test("computeSchedule: равные старты — порядок ввода", () => {
  const { entries } = computeSchedule(
    [
      { id: "a", name: "соус", minutes: 30 },
      { id: "b", name: "рис", minutes: 30 },
    ],
    at(20, 0), at(10, 0),
  );
  assert.deepEqual(entries.map(e => e.id), ["a", "b"]);
});

test("computeSchedule: четыре фазы статусов с границами", () => {
  const items = [{ id: "a", name: "утка", minutes: 60 }]; // старт 19:00
  const cases = [
    [at(18, 59), undefined, "waiting"],
    [at(19, 0), undefined, "due"],              // ровно старт, не подтверждено
    [at(19, 30), undefined, "due"],             // висит, пока не подтверждено
    [at(19, 30), new Set(["a"]), "cooking"],    // подтверждено
    [at(20, 0), new Set(["a"]), "served"],      // ровно подача
  ];
  for (const [now, acked, expected] of cases) {
    const { entries } = computeSchedule(items, at(20, 0), now, acked);
    assert.equal(entries[0].status, expected, `now=${now}`);
  }
});

test("computeSchedule: старт в прошлом — due сразу и держится", () => {
  const { entries } = computeSchedule(
    [{ id: "a", name: "гусь", minutes: 180 }], at(20, 0), at(19, 0),
  );
  assert.equal(entries[0].status, "due");
});

test("computeSchedule: невалидные позиции отфильтрованы", () => {
  const { entries } = computeSchedule(
    [
      { id: "a", name: "  ", minutes: 30 },
      { id: "b", name: "суп", minutes: 0 },
      { id: "c", name: "суп", minutes: NaN },
      { id: "d", name: "рис", minutes: 25 },
    ],
    at(20, 0), at(10, 0),
  );
  assert.deepEqual(entries.map(e => e.id), ["d"]);
});
