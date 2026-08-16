import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Fields that are never written to config.json when a keychain is available. */
export type SecretField = "botToken" | "appToken";

export type SecretBackend = "keychain" | "file";

/** Default: OS keychain. 0600 config file is the headless/container fallback. */
export interface SecretStore {
  readonly kind: SecretBackend;
  set(instance: string, field: SecretField, value: string): Promise<void>;
  get(instance: string, field: SecretField): Promise<string | null>;
  remove(instance: string, field: SecretField): Promise<void>;
}

const SERVICE = "herdr-slack";

const account = (instance: string, field: SecretField): string => `${instance}.${field}`;

/* v8 ignore start -- shells out to the platform keychain */
class MacKeychain implements SecretStore {
  readonly kind = "keychain" as const;

  async set(instance: string, field: SecretField, value: string): Promise<void> {
    // -U updates in place; -w passes the secret on argv (security CLI limitation).
    await run("security", [
      "add-generic-password",
      "-a",
      account(instance, field),
      "-s",
      SERVICE,
      "-w",
      value,
      "-U",
    ]);
  }

  async get(instance: string, field: SecretField): Promise<string | null> {
    try {
      const { stdout } = await run("security", [
        "find-generic-password",
        "-a",
        account(instance, field),
        "-s",
        SERVICE,
        "-w",
      ]);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async remove(instance: string, field: SecretField): Promise<void> {
    try {
      await run("security", [
        "delete-generic-password",
        "-a",
        account(instance, field),
        "-s",
        SERVICE,
      ]);
    } catch {
      // Already absent.
    }
  }
}

class SecretService implements SecretStore {
  readonly kind = "keychain" as const;

  async set(instance: string, field: SecretField, value: string): Promise<void> {
    const child = execFile("secret-tool", [
      "store",
      "--label",
      `${SERVICE} ${account(instance, field)}`,
      "service",
      SERVICE,
      "account",
      account(instance, field),
    ]);
    child.stdin?.end(value);
    await new Promise<void>((resolve, reject) => {
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
      child.on("error", reject);
    });
  }

  async get(instance: string, field: SecretField): Promise<string | null> {
    try {
      const { stdout } = await run("secret-tool", [
        "lookup",
        "service",
        SERVICE,
        "account",
        account(instance, field),
      ]);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async remove(instance: string, field: SecretField): Promise<void> {
    try {
      await run("secret-tool", ["clear", "service", SERVICE, "account", account(instance, field)]);
    } catch {
      // Already absent.
    }
  }
}
/* v8 ignore stop */

/** Fallback when no keychain — credentials stay in config.json (0600). */
export class FileSecretStore implements SecretStore {
  readonly kind = "file" as const;
  async set(): Promise<void> {}
  async get(): Promise<string | null> {
    return null;
  }
  async remove(): Promise<void> {}
}

/* v8 ignore start -- probes real binaries */
async function hasBinary(command: string, args: string[]): Promise<boolean> {
  try {
    await run(command, args);
    return true;
  } catch (error) {
    // A non-zero exit still proves the binary exists; only ENOENT means absent.
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** Pick the best available store for this machine. */
export async function detectSecretStore(): Promise<SecretStore> {
  if (process.platform === "darwin" && (await hasBinary("security", ["help"]))) {
    return new MacKeychain();
  }
  if (process.platform === "linux" && (await hasBinary("secret-tool", ["--version"]))) {
    return new SecretService();
  }
  return new FileSecretStore();
}
/* v8 ignore stop */

/** An in-memory store, for tests. */
export class MemorySecretStore implements SecretStore {
  readonly kind = "keychain" as const;
  #values = new Map<string, string>();

  async set(instance: string, field: SecretField, value: string): Promise<void> {
    this.#values.set(account(instance, field), value);
  }
  async get(instance: string, field: SecretField): Promise<string | null> {
    return this.#values.get(account(instance, field)) ?? null;
  }
  async remove(instance: string, field: SecretField): Promise<void> {
    this.#values.delete(account(instance, field));
  }
}
