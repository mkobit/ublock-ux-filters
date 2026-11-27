import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSanitizedEnv,
  cloneDirectoryWithHardlinks,
  prepareSession,
} from "./session.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createFakeFirefoxDir(root: string): string {
  const firefoxDir = join(root, "firefox-bin");
  mkdirSync(join(firefoxDir, "browser"), { recursive: true });
  writeFileSync(join(firefoxDir, "firefox"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(firefoxDir, "browser", "omni.ja"), "omni-data");
  return firefoxDir;
}

describe("session", () => {
  test("buildSanitizedEnv strips credentials and pins TZ and LANG", () => {
    const sanitized = buildSanitizedEnv({
      PATH: "/usr/bin",
      HOME: "/home/runner",
      TMPDIR: "/tmp",
      DISPLAY: ":99",
      GITHUB_TOKEN: "ghp_secret",
      GH_TOKEN: "gho_secret",
      AWS_SECRET_ACCESS_KEY: "aws_secret",
    });

    expect(sanitized).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/runner",
      TMPDIR: "/tmp",
      DISPLAY: ":99",
      TZ: "UTC",
      LANG: "en-US.UTF-8",
    });
    expect(sanitized["GITHUB_TOKEN"]).toBeUndefined();
    expect(sanitized["GH_TOKEN"]).toBeUndefined();
    expect(sanitized["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
  });

  test("prepares user.js and policies.json for filtered mode, and omits policies.json for raw mode", () => {
    const root = makeTempDir("ubouf-sess-");
    const firefoxDir = createFakeFirefoxDir(root);

    const filtered = prepareSession({
      firefoxDir,
      uboXpiPath: "/cache/uBlock0.xpi",
      mode: "filtered",
      userFilters: "127.0.0.1##.canary",
      baseTmpDir: root,
    });

    try {
      const userJs = readFileSync(join(filtered.profileDir, "user.js"), "utf8");
      expect(userJs).toContain('user_pref("ui.systemUsesDarkTheme", 0);');
      expect(userJs).toContain('user_pref("intl.accept_languages", "en-US");');
      expect(userJs).toContain('user_pref("layout.css.devPixelsPerPx", "1.0");');

      const policiesPath = join(filtered.firefoxBinDir, "distribution", "policies.json");
      expect(existsSync(policiesPath)).toBe(true);
      const policies = JSON.parse(readFileSync(policiesPath, "utf8")) as {
        policies: {
          Extensions: { Install: string[] };
          "3rdparty": {
            Extensions: {
              "uBlock0@raymondhill.net": {
                adminSettings: {
                  userSettings: { autoUpdate: boolean };
                  selectedFilterLists: string[];
                  userFilters: string;
                };
              };
            };
          };
        };
      };
      expect(policies.policies.Extensions.Install).toEqual(["/cache/uBlock0.xpi"]);
      const admin = policies.policies["3rdparty"].Extensions["uBlock0@raymondhill.net"].adminSettings;
      expect(admin.userSettings.autoUpdate).toBe(false);
      expect(admin.selectedFilterLists).toEqual(["user-filters"]);
      expect(admin.userFilters).toBe("127.0.0.1##.canary");
    } finally {
      filtered.cleanup();
    }
    expect(existsSync(filtered.tmpDir)).toBe(false);

    const raw = prepareSession({
      firefoxDir,
      mode: "raw",
      baseTmpDir: root,
    });
    try {
      expect(existsSync(join(raw.firefoxBinDir, "distribution", "policies.json"))).toBe(false);
    } finally {
      raw.cleanup();
    }
  });

  test("clones via hardlinks and falls back to copy on EXDEV", () => {
    const root = makeTempDir("ubouf-clone-");
    const firefoxDir = createFakeFirefoxDir(root);

    const hardlinkDest = join(root, "hardlink-dest");
    cloneDirectoryWithHardlinks(firefoxDir, hardlinkDest);
    expect(statSync(join(hardlinkDest, "firefox")).ino).toBe(
      statSync(join(firefoxDir, "firefox")).ino,
    );

    const exdevDest = join(root, "exdev-dest");
    cloneDirectoryWithHardlinks(firefoxDir, exdevDest, () => {
      const err = new Error("cross-device link not permitted") as NodeJS.ErrnoException;
      err.code = "EXDEV";
      throw err;
    });
    expect(existsSync(join(exdevDest, "firefox"))).toBe(true);
    expect(statSync(join(exdevDest, "firefox")).ino).not.toBe(
      statSync(join(firefoxDir, "firefox")).ino,
    );
    expect(readFileSync(join(exdevDest, "browser", "omni.ja"), "utf8")).toBe("omni-data");
  });

  test("respects keepProfile on cleanup", () => {
    const root = makeTempDir("ubouf-keep-");
    const firefoxDir = createFakeFirefoxDir(root);

    const session = prepareSession({
      firefoxDir,
      mode: "raw",
      keepProfile: true,
      baseTmpDir: root,
    });
    session.cleanup();
    expect(existsSync(session.tmpDir)).toBe(true);
  });
});
