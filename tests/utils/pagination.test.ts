import {
  buildCursorWhere,
  chunkArray,
  chunkResults,
  createCursor,
  createPaginatedResponse,
  decodeCursor,
  encodeCursor,
  PaginationError,
  paginateAll,
  parsePaginationParams,
} from "../../src/utils/pagination";

describe("encodeCursor / decodeCursor", () => {
  it("round-trips a cursor payload", () => {
    const cursor = encodeCursor({ v: 1, t: "2026-03-27T11:46:00.000Z", id: "txn-1" });
    expect(decodeCursor(cursor)).toEqual({
      v: 1,
      t: "2026-03-27T11:46:00.000Z",
      id: "txn-1",
    });
  });

  it("produces URL-safe output (no +, / or padding)", () => {
    const cursor = encodeCursor({ v: 1, t: "2026-03-27T11:46:00.000Z", id: "txn-1" });
    expect(cursor).not.toMatch(/[+/=]/);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("decodes the legacy `<timestamp>|<id>` cursor format", () => {
    const legacy = Buffer.from("2026-03-27T11:46:00.000Z|txn-9").toString("base64");
    expect(decodeCursor(legacy)).toEqual({
      v: 1,
      t: "2026-03-27T11:46:00.000Z",
      id: "txn-9",
    });
  });

  it("rejects malformed cursors", () => {
    expect(() => decodeCursor("")).toThrow(PaginationError);
    expect(() => decodeCursor("not-base64!")).toThrow(PaginationError);
    expect(() => decodeCursor(Buffer.from("garbage").toString("base64"))).toThrow(
      PaginationError,
    );
  });

  it("createCursor builds a cursor from a Date", () => {
    const cursor = createCursor(new Date("2026-03-27T11:46:00.000Z"), "txn-2");
    expect(decodeCursor(cursor)).toEqual({
      v: 1,
      t: "2026-03-27T11:46:00.000Z",
      id: "txn-2",
    });
  });
});

describe("parsePaginationParams", () => {
  it("applies defaults", () => {
    const params = parsePaginationParams({});
    expect(params).toMatchObject({ limit: 20, offset: 0 });
    expect(params.after).toBeUndefined();
    expect(params.before).toBeUndefined();
  });

  it("parses and clamps limit and offset", () => {
    expect(parsePaginationParams({ limit: "500" }).limit).toBe(100);
    expect(parsePaginationParams({ limit: "0" }).limit).toBe(1);
    expect(parsePaginationParams({ limit: "abc" }).limit).toBe(20);
    expect(parsePaginationParams({ offset: "-5" }).offset).toBe(0);
  });

  it("treats `cursor` as `after`", () => {
    const params = parsePaginationParams({ cursor: "abc123" });
    expect(params.after).toBe("abc123");
  });

  it("rejects both before and after", () => {
    expect(() =>
      parsePaginationParams({ before: "a", after: "b" }),
    ).toThrow(PaginationError);
  });
});

describe("buildCursorWhere", () => {
  const cursor = { v: 1 as const, t: "2026-03-27T11:46:00.000Z", id: "txn-1" };

  it("newest-first, fetch next page → strictly less than boundary", () => {
    const { clause, params } = buildCursorWhere(cursor, {
      column: "created_at",
      order: "desc",
      direction: "forward",
    });
    expect(clause).toBe("(created_at, id) < ($1, $2)");
    expect(params).toEqual([cursor.t, cursor.id]);
  });

  it("newest-first, fetch previous page → strictly greater than boundary", () => {
    const { clause } = buildCursorWhere(cursor, {
      column: "created_at",
      order: "desc",
      direction: "backward",
    });
    expect(clause).toBe("(created_at, id) > ($1, $2)");
  });

  it("oldest-first, fetch next page → strictly greater than boundary", () => {
    const { clause } = buildCursorWhere(cursor, {
      column: "created_at",
      order: "asc",
      direction: "forward",
    });
    expect(clause).toBe("(created_at, id) > ($1, $2)");
  });

  it("honours a custom param offset and id column", () => {
    const { clause, params } = buildCursorWhere(cursor, {
      column: "occurred_at",
      idColumn: "event_id",
      order: "desc",
      direction: "forward",
      paramOffset: 4,
    });
    expect(clause).toBe("(occurred_at, event_id) < ($4, $5)");
    expect(params).toEqual([cursor.t, cursor.id]);
  });
});

describe("createPaginatedResponse", () => {
  interface Row {
    id: string;
    createdAt: Date;
  }

  const rows: Row[] = [1, 2, 3].map((n) => ({
    id: `txn-${n}`,
    createdAt: new Date(`2026-03-2${n}T10:00:00.000Z`),
  }));

  it("marks hasMore when an overflow row is present and builds cursors", () => {
    const overflow = { id: "txn-4", createdAt: new Date("2026-03-24T10:00:00.000Z") };
    const result = createPaginatedResponse({
      rows: [...rows, overflow],
      limit: 3,
      getSortValue: (r) => r.createdAt,
      getId: (r) => r.id,
    });

    expect(result.data).toHaveLength(3);
    expect(result.pagination.hasMore).toBe(true);
    expect(result.pagination.nextCursor).not.toBeNull();
    expect(result.pagination.prevCursor).not.toBeNull();
    expect(decodeCursor(result.pagination.prevCursor!).id).toBe("txn-1");
    expect(decodeCursor(result.pagination.nextCursor!).id).toBe("txn-3");
  });

  it("returns null cursors for an empty page", () => {
    const result = createPaginatedResponse({
      rows: [],
      limit: 3,
      getSortValue: (r) => r.createdAt,
      getId: (r) => r.id,
    });
    expect(result.pagination).toEqual({
      limit: 3,
      nextCursor: null,
      prevCursor: null,
      hasMore: false,
    });
  });

  it("returns no nextCursor on the final page", () => {
    const result = createPaginatedResponse({
      rows,
      limit: 3,
      getSortValue: (r) => r.createdAt,
      getId: (r) => r.id,
    });
    expect(result.pagination.hasMore).toBe(false);
    expect(result.pagination.nextCursor).toBeNull();
    expect(result.pagination.prevCursor).not.toBeNull();
  });
});

describe("chunkArray", () => {
  it("splits into fixed-size chunks", () => {
    expect(chunkArray([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7],
    ]);
  });

  it("returns a single chunk when smaller than the chunk size", () => {
    expect(chunkArray([1, 2], 5)).toEqual([[1, 2]]);
  });

  it("rejects non-positive chunk sizes", () => {
    expect(() => chunkArray([1, 2], 0)).toThrow(PaginationError);
  });
});

describe("paginateAll / chunkResults (automatic chunking)", () => {
  it("follows cursors until the result set is exhausted", async () => {
    const source = [
      { id: "a", createdAt: new Date("2026-03-27T10:00:00.000Z") },
      { id: "b", createdAt: new Date("2026-03-26T10:00:00.000Z") },
      { id: "c", createdAt: new Date("2026-03-25T10:00:00.000Z") },
    ];

    const fetchPage = jest.fn(async (cursor?: string) => {
      // Cursor points at the last item of the previous page → next page starts after it.
      const start = cursor ? Number(decodeCursor(cursor).id) + 1 : 0;
      const page = source.slice(start, start + 2);
      const next =
        start + 2 < source.length
          ? createCursor(source[start + 1].createdAt, String(start + 1))
          : null;
      return { rows: page, nextCursor: next };
    });

    const collected: string[] = [];
    for await (const item of paginateAll(fetchPage, { limit: 2 })) {
      collected.push(item.id);
    }

    expect(collected).toEqual(["a", "b", "c"]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("chunkResults collects the full result set", async () => {
    const all = [10, 20, 30];
    let callCount = 0;
    const fetchPage = jest.fn(async () => {
      const idx = callCount++;
      return { rows: [all[idx]], nextCursor: idx < 2 ? "next" : null };
    });

    const results = await chunkResults(fetchPage, { limit: 1 });
    expect(results).toEqual([10, 20, 30]);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("paginateAll guards against a runaway cursor", async () => {
    const fetchPage = jest.fn(async () => ({ rows: [1], nextCursor: "next" }));

    const iterator = paginateAll(fetchPage, { limit: 1, maxPages: 3 });
    await expect(iterator.next()).resolves.toEqual({
      value: 1,
      done: false,
    });
    await expect(iterator.next()).resolves.toEqual({
      value: 1,
      done: false,
    });
    await expect(iterator.next()).resolves.toEqual({
      value: 1,
      done: false,
    });
    await expect(iterator.next()).rejects.toThrow(PaginationError);
  });
});
