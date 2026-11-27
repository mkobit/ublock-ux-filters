import {
  chmodSync,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type SessionMode = "raw" | "filtered";

export interface PrepareSessionOptions {
  firefoxDir: string;
  uboXpiPath?: string;
  mode: SessionMode;
  userFilters?: string;
  keepProfile?: boolean;
  baseTmpDir?: string;
}

export interface BrowserSession {
  tmpDir: string;
  firefoxBinDir: string;
  firefoxBin: string;
  profileDir: string;
  env: Record<string, string>;
  keepProfile: boolean;
  trackChild: (proc: { kill: (signal?: number | NodeJS.Signals) => void }) => void;
  cleanup: () => void;
}

const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
] as const;

export function buildSanitizedEnv(
  sourceEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = sourceEnv[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env["TZ"] = "UTC";
  env["LANG"] = "en-US.UTF-8";
  return env;
}

export function cloneDirectoryWithHardlinks(
  srcDir: string,
  destDir: string,
  linkFn: (existingPath: string, newPath: string) => void = linkSync,
): void {
  mkdirSync(destDir, { recursive: true, mode: 0o755 });
  const entries = readdirSync(srcDir);

  for (const entry of entries) {
    const srcPath = join(srcDir, entry);
    const destPath = join(destDir, entry);
    const stat = lstatSync(srcPath);

    if (stat.isSymbolicLink()) {
      const target = readlinkSync(srcPath);
      symlinkSync(target, destPath);
      continue;
    }

    if (stat.isDirectory()) {
      cloneDirectoryWithHardlinks(srcPath, destPath, linkFn);
      continue;
    }

    try {
      linkFn(srcPath, destPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EXDEV") {
        copyFileSync(srcPath, destPath);
        chmodSync(destPath, stat.mode & 0o777);
      } else {
        throw error;
      }
    }
  }
}

export function buildUserJsContent(): string {
  return [
    'user_pref("ui.systemUsesDarkTheme", 0);',
    'user_pref("intl.accept_languages", "en-US");',
    'user_pref("layout.css.devPixelsPerPx", "1.0");',
    "",
  ].join("\n");
}

export function buildPoliciesJson(uboXpiPath: string, userFilters: string): string {
  const policies = {
    policies: {
      Extensions: {
        Install: [uboXpiPath],
      },
      "3rdparty": {
        Extensions: {
          "uBlock0@raymondhill.net": {
            adminSettings: {
              userSettings: {
                autoUpdate: false,
              },
              selectedFilterLists: ["user-filters"],
              userFilters,
            },
          },
        },
      },
    },
  };
  return `${JSON.stringify(policies, null, 2)}\n`;
}

function makeWritableAndRemove(targetDir: string): void {
  try {
    const stat = lstatSync(targetDir);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      chmodSync(targetDir, 0o755);
      for (const entry of readdirSync(targetDir)) {
        const child = join(targetDir, entry);
        const childStat = lstatSync(child);
        if (childStat.isDirectory() && !childStat.isSymbolicLink()) {
          makeWritableAndRemove(child);
        }
      }
    }
  } catch {
    // Best-effort permission relaxation before rmSync.
  }
  rmSync(targetDir, { recursive: true, force: true });
}

export function prepareSession(options: PrepareSessionOptions): BrowserSession {
  const rootTmp = options.baseTmpDir ?? tmpdir();
  const tmpDir = mkdtempSync(join(rootTmp, "ubouf-session-"));
  const firefoxBinDir = join(tmpDir, "firefox-bin");
  const profileDir = join(tmpDir, "profile");
  const keepProfile = options.keepProfile ?? false;

  cloneDirectoryWithHardlinks(options.firefoxDir, firefoxBinDir);
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, "user.js"), buildUserJsContent(), "utf8");

  if (options.mode !== "raw") {
    if (!options.uboXpiPath) {
      makeWritableAndRemove(tmpDir);
      throw new Error("uboXpiPath is required when session mode is not 'raw'");
    }
    const distDir = join(firefoxBinDir, "distribution");
    mkdirSync(distDir, { recursive: true, mode: 0o755 });
    writeFileSync(
      join(distDir, "policies.json"),
      buildPoliciesJson(options.uboXpiPath, options.userFilters ?? ""),
      "utf8",
    );
  }

  const env = buildSanitizedEnv();
  const children = new Set<{ kill: (signal?: number | NodeJS.Signals) => void }>();
  let cleaned = false;

  const cleanup = (): void => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);

    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore already-exited child processes.
      }
    }
    children.clear();

    if (!keepProfile) {
      makeWritableAndRemove(tmpDir);
    }
  };

  const onSigint = (): void => {
    cleanup();
    process.exit(130);
  };
  const onSigterm = (): void => {
    cleanup();
    process.exit(143);
  };

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  return {
    tmpDir,
    firefoxBinDir,
    firefoxBin: join(firefoxBinDir, "firefox"),
    profileDir,
    env,
    keepProfile,
    trackChild: (proc) => {
      children.add(proc);
    },
    cleanup,
  };
}
