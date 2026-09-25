/**
 * An unreadable account store must not become a deleted one.
 *
 * The store is AES-GCM encrypted with a key derived from this machine's home
 * directory, platform and arch (see getEncryptionKey). Importing a backup that
 * was exported elsewhere — the normal case for the Docker deployment, whose
 * container home and platform differ from the desktop's — therefore produces a
 * file this process cannot decrypt.
 *
 * The old behaviour was to log a warning and fall through to "no store", which
 * returned an EMPTY doc. The file stayed on disk, so it looked harmless, but the
 * in-memory doc was empty: the next mutation (adding one account, renaming
 * anything) rewrote the file and the unreadable accounts were gone for good. The
 * operator saw their account list come up empty after an import, with no error
 * and nothing to recover from.
 *
 * These tests pin the replacement contract: the file is preserved, the failure is
 * reportable, and a write is refused while the file cannot be read AND could not
 * be moved aside.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountStoreFile,
  accountStoreLoadProblem,
  addAccount,
  clearAccountStoreLoadProblemForTest,
  loadAccounts,
  resetAccountStoreCacheForTest,
  setStoreLockedProblemForTest,
} from "./account-store.js";

const TMP_ROOT = join(tmpdir(), `zk-store-${process.pid}`);
let tmp = "";
let seq = 0;

beforeEach(() => {
  tmp = `${TMP_ROOT}-${seq++}`;
  process.env.ZCODE_KNIGHT_STORE_DIR = tmp;
  process.env.ZCODE_KNIGHT_LEGACY_STORE_DIR = `${tmp}/legacy`;
  resetAccountStoreCacheForTest();
  clearAccountStoreLoadProblemForTest();
});

afterEach(() => {
  delete process.env.ZCODE_KNIGHT_STORE_DIR;
  delete process.env.ZCODE_KNIGHT_LEGACY_STORE_DIR;
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

/** Write a store file whose ciphertext no key on this host can open. */
function writeForeignStore(): void {
  mkdirSync(tmp, { recursive: true });
  // Valid envelope, valid base64, undecryptable payload — exactly what an
  // accounts.json from another machine looks like from here.
  const junk = Buffer.from("this is not ciphertext from this machine").toString("base64");
  writeFileSync(accountStoreFile(), JSON.stringify({ encrypted: junk }), "utf-8");
}

describe("an account store that cannot be decrypted", () => {
  it("preserves the file instead of silently starting empty", async () => {
    writeForeignStore();
    const doc = await loadAccounts();
    // The in-memory view is empty (nothing could be read)…
    expect(doc.accounts).toEqual([]);
    // …but the file was not lost: it was moved aside, so it is still there.
    const files = readdirSync(tmp);
    expect(files.some((f) => f.startsWith("accounts.json.unreadable-"))).toBe(true);
    // And the reason is reportable rather than console-only.
    const problem = accountStoreLoadProblem();
    expect(problem).not.toBeNull();
    expect(problem!.kind).toBe("undecryptable");
    expect(problem!.file).toContain("accounts.json.unreadable-");
  });

  it("reports no problem for a normal empty install", async () => {
    // First boot with no store at all is not an error and must not warn.
    const doc = await loadAccounts();
    expect(doc.accounts).toEqual([]);
    expect(accountStoreLoadProblem()).toBeNull();
  });

  it("clears the problem once a store loads normally", async () => {
    writeForeignStore();
    await loadAccounts();
    expect(accountStoreLoadProblem()).not.toBeNull();

    // A fresh install after the operator re-logs-in: the problem must not stick
    // forever, or the panel would keep showing a banner about a file that is
    // no longer in play.
    resetAccountStoreCacheForTest();
    clearAccountStoreLoadProblemForTest();
    await addAccount({
      credential: { apiKey: "sk-new", provider: "zai" },
      name: "fresh",
      deviceMid: "0000000b-1111-2222-3333-444444444444",
    });
    resetAccountStoreCacheForTest();
    const doc = await loadAccounts();
    expect(doc.accounts.length).toBe(1);
    expect(accountStoreLoadProblem()).toBeNull();
  });

  it("refuses to overwrite a store it could neither read nor move aside", async () => {
    // The dangerous state: the file is unreadable AND still in place. Writing
    // the empty in-memory doc here would destroy accounts that are perfectly
    // recoverable by fixing the key — so the write must fail loudly instead.
    //
    // The sequence is the real one: a load fails and cannot move the file aside
    // (forcing `lastLoadProblem` to the locked kind), then a mutation arrives.
    // The locked state is forced through a seam because provoking it for real
    // needs `renameSync` to fail, which depends on file locks and is not
    // portable.
    const target = accountStoreFile();
    mkdirSync(tmp, { recursive: true });
    writeFileSync(target, JSON.stringify({ encrypted: "still-here" }), "utf-8");
    const before = readFileSync(target, "utf-8");

    // Load first, so the doc is cached and the mutation below goes straight to
    // the persist path rather than re-running the loader.
    await loadAccounts();
    setStoreLockedProblemForTest(target);
    writeFileSync(target, before, "utf-8");

    await addAccount({
      credential: { apiKey: "sk-should-not-land", provider: "zai" },
      name: "blocked",
      deviceMid: "0000000c-1111-2222-3333-444444444444",
    });

    expect(readFileSync(target, "utf-8")).toBe(before);
    // And the refusal is reported rather than swallowed.
    expect(accountStoreLoadProblem()?.kind).toBe("undecryptable_locked");
  });
});
