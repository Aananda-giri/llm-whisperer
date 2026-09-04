import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { validateBrowserProfile } from "../browser.js";

export type LoginMethod = "password" | "manual";

/**
 * One storeable credential. The password lives in an ES2022 `#` private field
 * so a bare `JSON.stringify(cred)` never emits it (the `toJSON()` projection
 * is belt-and-braces on top). Only the login driver may read `.password`.
 */
export class Credential {
  #password?: string;

  constructor(
    public email: string,
    public method: LoginMethod,
    public updatedAt: string,
    password?: string,
    public note?: string,
  ) {
    this.#password = password;
  }

  /** The plaintext password. Callers: the login driver, and `wspr creds show`. */
  get password(): string | undefined {
    return this.#password;
  }

  get hasPassword(): boolean {
    return this.#password !== undefined;
  }

  /** Full shape for the vault file — password included. Vault serialization only. */
  toStored(): StoredCredential {
    return {
      email: this.email,
      password: this.#password,
      method: this.method,
      note: this.note,
      updatedAt: this.updatedAt,
    };
  }

  static fromStored(s: StoredCredential): Credential {
    return new Credential(s.email, s.method, s.updatedAt, s.password, s.note);
  }

  /**
   * Projection used by `JSON.stringify`. Omits the password and any empty
   * optional fields — an accidental `res.json(cred)` or `console.log(cred)`
   * cannot leak the secret.
   */
  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      email: this.email,
      method: this.method,
      updatedAt: this.updatedAt,
    };
    if (this.note) out.note = this.note;
    if (this.hasPassword) out.hasPassword = true;
    return out;
  }
}

/** The form a credential is written in to the vault file. */
export interface StoredCredential {
  email: string;
  password?: string;
  method: LoginMethod;
  note?: string;
  updatedAt: string;
}

/** The only view the server and dashboard may ever see — never has a password. */
export interface RedactedCredential {
  profile: string;
  provider: string;
  email: string;
  method: LoginMethod;
  hasPassword: boolean;
  updatedAt: string;
}

export interface VaultData {
  version: 1;
  /** profile → provider → stored credential. */
  profiles: Record<string, Record<string, StoredCredential>>;
}

export interface VaultOptions {
  /** Path to the encrypted vault file, e.g. <profilesDir>/credentials.enc. */
  filePath: string;
  /** Valid provider names; a `set` for an unknown provider is rejected. */
  providers: readonly string[];
}

export interface Vault {
  readonly filePath: string;
  /** The credential — the ONE accessor the login driver may call. */
  get(profile: string, provider: string): Credential | undefined;
  /** Redacted projection — never includes a password. Safe for the server/UI. */
  listRedacted(profile?: string): RedactedCredential[];
  set(profile: string, provider: string, cred: Credential): Promise<void>;
  remove(profile: string, provider: string): Promise<void>;
}

const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const DEFAULT_SCRYPT = { N: 16384, r: 8, p: 1 };
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

interface Envelope {
  v: 1;
  kdf: { N: number; r: number; p: number; salt: string };
  iv: string;
  tag: string;
  ct: string;
}

function deriveKey(passphrase: string, salt: Buffer, N: number, r: number, p: number): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, { N, r, p, maxmem: SCRYPT_MAXMEM });
}

function encrypt(passphrase: string, plain: string): Envelope {
  const salt = randomBytes(16);
  const params = DEFAULT_SCRYPT;
  const key = deriveKey(passphrase, salt, params.N, params.r, params.p);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    kdf: { N: params.N, r: params.r, p: params.p, salt: salt.toString("base64") },
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
  };
}

function decrypt(passphrase: string, env: Envelope): string {
  const salt = Buffer.from(env.kdf.salt, "base64");
  const key = deriveKey(passphrase, salt, env.kdf.N, env.kdf.r, env.kdf.p);
  const iv = Buffer.from(env.iv, "base64");
  const tag = Buffer.from(env.tag, "base64");
  const ct = Buffer.from(env.ct, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/**
 * The vault could not be decrypted with the passphrase given. Carries no
 * detail beyond the path — there is nothing to distinguish a wrong passphrase
 * from a tampered file, and saying more would only guess.
 */
export class WrongPassphraseError extends Error {
  constructor(public readonly filePath: string) {
    super(
      `Could not decrypt the vault at "${filePath}" — wrong passphrase ` +
        `(set WSPR_VAULT_KEY, or re-enter it at the prompt).`,
    );
    this.name = "WrongPassphraseError";
  }
}

/**
 * Open (and lazily create) the encrypted vault. A wrong passphrase fails
 * cleanly at load with a message — the file is never truncated or rewritten on
 * a failed open.
 */
export async function openVault(passphrase: string, opts: VaultOptions): Promise<CredentialVault> {
  return CredentialVault.open(passphrase, opts);
}

/**
 * A `Vault` that may be locked. The server and providers receive one of these
 * so they never hold the passphrase for login attempts; the dashboard unlocks
 * it via {@link VaultHandle.unlock}, and (without one) every accessor behaves
 * as an empty vault until the passphrase is supplied.
 */
export class VaultHandle implements Vault {
  private inner: CredentialVault | undefined;

  constructor(private readonly opts: VaultOptions) {
    this.inner = undefined;
  }

  get filePath(): string {
    return this.opts.filePath;
  }

  get locked(): boolean {
    return this.inner === undefined;
  }

  async unlock(passphrase: string): Promise<void> {
    this.inner = CredentialVault.open(passphrase, this.opts);
  }

  get(profile: string, provider: string): Credential | undefined {
    return this.inner?.get(profile, provider);
  }

  listRedacted(profile?: string): RedactedCredential[] {
    return this.inner?.listRedacted(profile) ?? [];
  }

  async set(profile: string, provider: string, cred: Credential): Promise<void> {
    if (!this.inner) {
      throw new Error("Vault is locked. Set WSPR_VAULT_KEY or unlock it through the dashboard.");
    }
    return this.inner.set(profile, provider, cred);
  }

  async remove(profile: string, provider: string): Promise<void> {
    if (!this.inner) {
      throw new Error("Vault is locked. Set WSPR_VAULT_KEY or unlock it through the dashboard.");
    }
    return this.inner.remove(profile, provider);
  }
}

export class CredentialVault implements Vault {
  private profiles: Record<string, Record<string, Credential>> = {};

  private constructor(
    private readonly passphrase: string,
    private readonly opts: VaultOptions,
  ) {}

  static open(passphrase: string, opts: VaultOptions): CredentialVault {
    return new CredentialVault(passphrase, opts).load();
  }

  get filePath(): string {
    return this.opts.filePath;
  }

  private load(): this {
    if (!existsSync(this.opts.filePath)) {
      this.profiles = {};
      return this;
    }
    let env: Envelope;
    try {
      env = JSON.parse(readFileSync(this.opts.filePath, "utf8")) as Envelope;
    } catch {
      throw new Error(
        `Could not parse vault file "${this.opts.filePath}". It may be corrupted.`,
      );
    }
    let raw: string;
    try {
      raw = decrypt(this.passphrase, env);
    } catch {
      // AES-GCM authentication failed. That is almost always a wrong
      // passphrase; a tampered or truncated file looks identical from here.
      throw new WrongPassphraseError(this.opts.filePath);
    }
    const data = JSON.parse(raw) as VaultData;
    if (data?.version !== 1 || typeof data.profiles !== "object") {
      throw new Error(`Unrecognized vault format in "${this.opts.filePath}".`);
    }
    for (const [profile, byProvider] of Object.entries(data.profiles)) {
      validateBrowserProfile(profile);
      this.profiles[profile] = {};
      for (const [provider, stored] of Object.entries(byProvider ?? {})) {
        this.profiles[profile][provider] = Credential.fromStored(stored);
      }
    }
    return this;
  }

  private persist(): void {
    const data: VaultData = { version: 1, profiles: {} };
    for (const [profile, byProvider] of Object.entries(this.profiles)) {
      const out: Record<string, StoredCredential> = {};
      for (const [provider, cred] of Object.entries(byProvider)) {
        out[provider] = cred.toStored();
      }
      data.profiles[profile] = out;
    }
    const env = encrypt(this.passphrase, JSON.stringify(data));
    mkdirSync(dirname(this.opts.filePath), { recursive: true });

    // Write-then-rename. This file is the only copy of every stored password,
    // so a crash or a full disk must never leave it half-written: the rename
    // is atomic within a filesystem, and the temp file carries 0600 from
    // creation so the secret is never briefly world-readable.
    const tmp = `${this.opts.filePath}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, JSON.stringify(env, null, 2), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.opts.filePath);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  private validProvider(provider: string): string {
    if (!this.opts.providers.includes(provider)) {
      throw new Error(
        `Unknown provider "${provider}". Known providers: ${this.opts.providers.join(", ")}`,
      );
    }
    return provider;
  }

  get(profile: string, provider: string): Credential | undefined {
    return this.profiles[profile]?.[provider];
  }

  listRedacted(profile?: string): RedactedCredential[] {
    const out: RedactedCredential[] = [];
    const profiles = profile ? [profile] : Object.keys(this.profiles);
    for (const p of profiles) {
      for (const [provider, cred] of Object.entries(this.profiles[p] ?? {})) {
        out.push({
          profile: p,
          provider,
          email: cred.email,
          method: cred.method,
          hasPassword: cred.hasPassword,
          updatedAt: cred.updatedAt,
        });
      }
    }
    return out;
  }

  async set(profile: string, provider: string, cred: Credential): Promise<void> {
    validateBrowserProfile(profile);
    this.validProvider(provider);
    this.profiles[profile] ??= {};
    this.profiles[profile][provider] = cred;
    this.persist();
  }

  async remove(profile: string, provider: string): Promise<void> {
    validateBrowserProfile(profile);
    this.validProvider(provider);
    delete this.profiles[profile]?.[provider];
    if (this.profiles[profile] && Object.keys(this.profiles[profile]).length === 0) {
      delete this.profiles[profile];
    }
    this.persist();
  }
}
