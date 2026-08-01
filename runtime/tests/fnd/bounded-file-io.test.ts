import {
  link,
  mkdtemp,
  open,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BoundedFileIoError,
  decodeFatalUtf8,
  MAX_BOUNDED_FILE_LABEL_UTF8_BYTES,
  MAX_BOUNDED_FILE_PATH_UTF8_BYTES,
  MAX_BOUNDED_FILE_READ_BYTES,
  readBoundedRegularFile,
} from "../helpers/bounded-file-io.js";

const TEST_FILE_LIMIT = 16;
const roots = new Set<string>();

type FileHandleRead = (
  this: unknown,
  buffer: Uint8Array,
  offset: number,
  length: number,
  position: number,
) => Promise<{ bytesRead: number; buffer: Uint8Array }>;

afterEach(async () => {
  await Promise.all(
    [...roots].map(async (root) => {
      await rm(root, { force: true, recursive: true });
      roots.delete(root);
    }),
  );
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agenc-bounded-io-test-"));
  roots.add(root);
  return root;
}

async function expectIoError(
  action: () => Promise<unknown>,
  code: BoundedFileIoError["code"],
): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(BoundedFileIoError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected BoundedFileIoError ${code}`);
}

async function withFirstDescriptorReadHook<T>(
  hook: () => Promise<void>,
  action: () => Promise<T>,
): Promise<T> {
  const root = await createRoot();
  const probePath = join(root, "prototype-probe");
  await writeFile(probePath, "probe");
  const probe = await open(probePath, "r");
  const prototype = Object.getPrototypeOf(probe) as {
    read: FileHandleRead;
  };
  await probe.close();

  const originalRead = prototype.read;
  let hooked = false;
  prototype.read = async function patchedRead(
    buffer,
    offset,
    length,
    position,
  ) {
    const result = await originalRead.call(
      this,
      buffer,
      offset,
      length,
      position,
    );
    if (!hooked) {
      hooked = true;
      await hook();
    }
    return result;
  };
  try {
    return await action();
  } finally {
    prototype.read = originalRead;
  }
}

describe("bounded descriptor file I/O", () => {
  it("reads empty and exact-limit files and returns independent buffers", async () => {
    const root = await createRoot();
    const emptyPath = join(root, "empty.bin");
    const exactPath = join(root, "exact.bin");
    await writeFile(emptyPath, Buffer.alloc(0));
    await writeFile(exactPath, Buffer.from("0123456789abcdef"));

    expect(
      await readBoundedRegularFile(emptyPath, {
        byteLimit: 0,
        label: "empty fixture",
      }),
    ).toEqual(Buffer.alloc(0));
    const first = await readBoundedRegularFile(exactPath, {
      byteLimit: TEST_FILE_LIMIT,
      label: "exact fixture",
    });
    first[0] = 0xff;
    expect(
      await readBoundedRegularFile(exactPath, {
        byteLimit: TEST_FILE_LIMIT,
        label: "exact fixture",
      }),
    ).toEqual(Buffer.from("0123456789abcdef"));
  });

  it("rejects a limit-plus-one file without retaining a descriptor", async () => {
    const root = await createRoot();
    const path = join(root, "oversized.bin");
    await writeFile(path, Buffer.alloc(TEST_FILE_LIMIT + 1));

    await expectIoError(
      () =>
        readBoundedRegularFile(path, {
          byteLimit: TEST_FILE_LIMIT,
          label: "oversized fixture",
        }),
      "limit",
    );
    await rm(path);
  });

  it("detects descriptor growth with one bounded EOF probe", async () => {
    const root = await createRoot();
    const path = join(root, "growing.bin");
    await writeFile(path, Buffer.from("four"));

    await withFirstDescriptorReadHook(
      () => writeFile(path, Buffer.from("fives")),
      () =>
        expectIoError(
          () =>
            readBoundedRegularFile(path, {
              byteLimit: 4,
              label: "growing fixture",
            }),
          "limit",
        ),
    );
    await rm(path);
  });

  it("detects truncation while retaining the opened descriptor identity", async () => {
    const root = await createRoot();
    const path = join(root, "shrinking.bin");
    await writeFile(path, Buffer.from("content"));

    await withFirstDescriptorReadHook(
      () => truncate(path, 1),
      () =>
        expectIoError(
          () =>
            readBoundedRegularFile(path, {
              byteLimit: TEST_FILE_LIMIT,
              label: "shrinking fixture",
            }),
          "changed",
        ),
    );
  });

  it("detects pathname replacement after opening the original inode", async () => {
    const root = await createRoot();
    const path = join(root, "replaceable.bin");
    const displaced = join(root, "displaced.bin");
    await writeFile(path, Buffer.from("original"));

    await withFirstDescriptorReadHook(
      async () => {
        await rename(path, displaced);
        await writeFile(path, Buffer.from("replaced"));
      },
      () =>
        expectIoError(
          () =>
            readBoundedRegularFile(path, {
              byteLimit: TEST_FILE_LIMIT,
              label: "replaced fixture",
            }),
          "changed",
        ),
    );
  });

  it("preserves simultaneous read and descriptor-close failures", async () => {
    const root = await createRoot();
    const path = join(root, "aggregate.bin");
    const probePath = join(root, "close-probe.bin");
    await writeFile(path, Buffer.from("four"));
    await writeFile(probePath, Buffer.from("probe"));
    const probe = await open(probePath, "r");
    const prototype = Object.getPrototypeOf(probe) as {
      read: FileHandleRead;
    };
    await probe.close();
    const originalRead = prototype.read;
    let readHooked = false;
    prototype.read = async function patchedRead(
      buffer,
      offset,
      length,
      position,
    ) {
      const result = await originalRead.call(
        this,
        buffer,
        offset,
        length,
        position,
      );
      if (!readHooked) {
        readHooked = true;
        const handle = this as { close: () => Promise<void> };
        const close = handle.close;
        Object.defineProperty(handle, "close", {
          configurable: true,
          value: async () => {
            await close.call(handle);
            throw new Error("injected close failure");
          },
        });
        await writeFile(path, Buffer.from("fives"));
      }
      return result;
    };
    try {
      await expect(
        readBoundedRegularFile(path, {
          byteLimit: 4,
          label: "aggregate fixture",
        }),
      ).rejects.toMatchObject({
        name: "AggregateError",
        errors: [{ code: "limit" }, expect.any(Error)],
      });
    } finally {
      prototype.read = originalRead;
    }
    await rm(path);
  });

  it("rejects symbolic links, hard links, and directories", async () => {
    const root = await createRoot();
    const target = join(root, "target.bin");
    const symbolic = join(root, "symbolic.bin");
    const hard = join(root, "hard.bin");
    await writeFile(target, "target");

    try {
      await symlink(target, symbolic, "file");
      await expectIoError(
        () => readBoundedRegularFile(symbolic, { byteLimit: TEST_FILE_LIMIT }),
        "invalid_type",
      );
    } catch (error) {
      expect(["EACCES", "ENOTSUP", "EPERM"]).toContain(
        (error as NodeJS.ErrnoException).code,
      );
    }

    try {
      await link(target, hard);
      await expectIoError(
        () => readBoundedRegularFile(target, { byteLimit: TEST_FILE_LIMIT }),
        "hard_link",
      );
    } catch (error) {
      expect(["EACCES", "ENOTSUP", "EPERM"]).toContain(
        (error as NodeJS.ErrnoException).code,
      );
    }

    await expectIoError(
      () => readBoundedRegularFile(root, { byteLimit: TEST_FILE_LIMIT }),
      "invalid_type",
    );
  });

  it("rejects invalid limits and hostile option records before opening", async () => {
    const root = await createRoot();
    const path = join(root, "safe.bin");
    await writeFile(path, "safe");

    for (const byteLimit of [
      -1,
      Number.NaN,
      1.5,
      MAX_BOUNDED_FILE_READ_BYTES + 1,
    ]) {
      await expectIoError(
        () => readBoundedRegularFile(path, { byteLimit }),
        "invalid_limit",
      );
    }
    await expectIoError(
      () =>
        readBoundedRegularFile(
          path,
          new Proxy({ byteLimit: TEST_FILE_LIMIT }, {}) as {
            byteLimit: number;
          },
        ),
      "invalid_options",
    );

    let getterCalls = 0;
    const accessorOptions = Object.defineProperty({}, "byteLimit", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return TEST_FILE_LIMIT;
      },
    }) as { byteLimit: number };
    await expectIoError(
      () => readBoundedRegularFile(path, accessorOptions),
      "invalid_limit",
    );
    expect(getterCalls).toBe(0);
  });

  it("rejects malformed and over-limit paths before filesystem access", async () => {
    const overLimitPath = "\u0800".repeat(
      Math.floor(MAX_BOUNDED_FILE_PATH_UTF8_BYTES / 3) + 1,
    );
    expect(overLimitPath.length).toBeLessThan(MAX_BOUNDED_FILE_PATH_UTF8_BYTES);

    for (const path of [
      "",
      "nul\0path",
      `surrogate-${String.fromCharCode(0xd800)}`,
      overLimitPath,
    ]) {
      await expectIoError(
        () => readBoundedRegularFile(path, { byteLimit: TEST_FILE_LIMIT }),
        "invalid_path",
      );
    }
  });

  it("rejects hostile labels and unsupported option keys without getters", async () => {
    const root = await createRoot();
    const path = join(root, "safe-label.bin");
    await writeFile(path, "safe");
    const overLimitLabel = "\u0800".repeat(
      Math.floor(MAX_BOUNDED_FILE_LABEL_UTF8_BYTES / 3) + 1,
    );
    expect(overLimitLabel.length).toBeLessThan(
      MAX_BOUNDED_FILE_LABEL_UTF8_BYTES,
    );

    for (const label of [
      "",
      "line\nbreak",
      `surrogate-${String.fromCharCode(0xd800)}`,
      overLimitLabel,
    ]) {
      await expectIoError(
        () =>
          readBoundedRegularFile(path, { byteLimit: TEST_FILE_LIMIT, label }),
        "invalid_label",
      );
    }

    let getterCalls = 0;
    const accessorLabel = Object.defineProperties(
      {},
      {
        byteLimit: { enumerable: true, value: TEST_FILE_LIMIT },
        label: {
          enumerable: true,
          get() {
            getterCalls += 1;
            return "hostile label";
          },
        },
      },
    ) as { readonly byteLimit: number; readonly label: string };
    await expectIoError(
      () => readBoundedRegularFile(path, accessorLabel),
      "invalid_options",
    );
    expect(getterCalls).toBe(0);

    await expectIoError(
      () =>
        readBoundedRegularFile(path, {
          byteLimit: TEST_FILE_LIMIT,
          unsupported: true,
        } as { byteLimit: number }),
      "invalid_options",
    );
    const symbolicOptions = Object.assign(
      { byteLimit: TEST_FILE_LIMIT },
      { [Symbol("unsupported")]: true },
    );
    await expectIoError(
      () => readBoundedRegularFile(path, symbolicOptions),
      "invalid_options",
    );
  });

  it("decodes fatal UTF-8 without stripping a BOM", () => {
    expect(decodeFatalUtf8(Buffer.from("plain"), "plain fixture")).toBe(
      "plain",
    );
    expect(
      decodeFatalUtf8(Buffer.from([0xef, 0xbb, 0xbf, 0x61]), "BOM fixture"),
    ).toBe("\ufeffa");
    expect(() =>
      decodeFatalUtf8(Buffer.from([0xc3, 0x28]), "invalid fixture"),
    ).toThrowError(BoundedFileIoError);
    expect(() =>
      decodeFatalUtf8(
        new Proxy(new Uint8Array([0x61]), {}) as Uint8Array,
        "proxy fixture",
      ),
    ).toThrowError(BoundedFileIoError);
    expect(() =>
      decodeFatalUtf8(
        new Uint8Array(new SharedArrayBuffer(1)),
        "shared fixture",
      ),
    ).toThrowError(BoundedFileIoError);
    const detached = new Uint8Array([0x61]);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    expect(() => decodeFatalUtf8(detached, "detached fixture")).toThrowError(
      BoundedFileIoError,
    );
  });

  it("copies typed-array subclasses without invoking their accessors", () => {
    let getterCalls = 0;
    class HostileBytes extends Uint8Array {
      override get buffer(): ArrayBuffer {
        getterCalls += 1;
        throw new Error("typed-array buffer getter must stay inert");
      }

      override get byteLength(): number {
        getterCalls += 1;
        throw new Error("typed-array byteLength getter must stay inert");
      }
    }

    expect(decodeFatalUtf8(new HostileBytes([0x61]), "subclass fixture")).toBe(
      "a",
    );
    expect(getterCalls).toBe(0);
  });
});
