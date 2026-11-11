import type { AccessTokenSource } from '@/core/data/http-client';
import type { AppError } from '@/core/domain/app-error';
import { err, ok, type Result } from '@/core/domain/result';
import type { Session } from '../../domain/entities/session';
import type { AuthRepository } from '../../domain/repositories/auth-repository';
import type { GatewayAuthDataSource } from '../datasources/gateway-auth-datasource';

/** "Has signed in on this browser" flag — not a credential, only decides whether a silent refresh is worth a request. */
export interface SessionHintStore {
  get(): boolean;
  set(value: boolean): void;
}

/** Cross-tab refresh coordination: the Web Locks subset and a same-origin session broadcast. */
export interface RefreshCoordination {
  locks: { request<T>(name: string, cb: () => Promise<T>): Promise<T> } | null;
  channel: { postMessage(m: unknown): void; onmessage: ((e: MessageEvent) => void) | null } | null;
}

const LOCK_NAME = 'salesmesh-refresh';
const CHANNEL_NAME = 'salesmesh-session';
/** A session another tab just refreshed is reused only if it still has this much life left. */
const REUSE_MIN_TTL_MS = 5_000;

const browserCoordination = (): RefreshCoordination => ({
  locks: typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null,
  channel: typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL_NAME),
});

const HINT_KEY = 'salesmesh.session-hint';

export const localStorageHint: SessionHintStore = {
  get() {
    try {
      return window.localStorage.getItem(HINT_KEY) === '1';
    } catch {
      return false;
    }
  },
  set(value) {
    try {
      if (value) window.localStorage.setItem(HINT_KEY, '1');
      else window.localStorage.removeItem(HINT_KEY);
    } catch {
      /* storage unavailable (private mode): the dashboard still probes on its own */
    }
  },
};

/** Holds the session in memory and is the HttpClient's token source (single-flight refresh). */
export class GatewayAuthRepository implements AuthRepository, AccessTokenSource {
  private session: Session | null = null;
  private inflight: Promise<Result<Session, AppError>> | null = null;
  /** Bumped by login/logout/clear/changePin so a refresh that started earlier can't overwrite them. */
  private generation = 0;
  /** Bumped whenever another tab broadcasts a refreshed session. */
  private remoteVersion = 0;
  private readonly listeners = new Set<(s: Session | null) => void>();
  private readonly coord: RefreshCoordination;

  constructor(
    private readonly ds: GatewayAuthDataSource,
    private readonly hint: SessionHintStore = localStorageHint,
    coord?: RefreshCoordination
  ) {
    this.coord = coord ?? browserCoordination();
    if (this.coord.channel) {
      this.coord.channel.onmessage = (e) => {
        const m = e.data as { type?: string; session?: Session } | null;
        if (m?.type !== 'session' || !m.session || m.session.expiresAt <= Date.now()) return;
        this.remoteVersion++;
        this.set(m.session, false);
      };
    }
  }

  current(): Session | null {
    return this.session;
  }

  hasSessionHint(): boolean {
    return this.hint.get();
  }

  subscribe(listener: (s: Session | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async login(phone: string, pin: string): Promise<Result<Session, AppError>> {
    this.generation++;
    return this.adopt(await this.ds.login(phone, pin));
  }

  refresh(): Promise<Result<Session, AppError>> {
    // Single-flight in this tab; across tabs the Web Lock serialises the server call (below).
    this.inflight ??= this.lockedRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async lockedRefresh(): Promise<Result<Session, AppError>> {
    const { locks } = this.coord;
    if (!locks) return this.callServer(); // shortcut: no Web Locks, tabs can still race; in-tab single-flight only
    const seen = this.remoteVersion;
    const run = async (): Promise<Result<Session, AppError>> => {
      // Another tab refreshed while we waited for the lock: its broadcast already updated us.
      const s = this.session;
      if (this.remoteVersion !== seen && s && s.expiresAt - Date.now() > REUSE_MIN_TTL_MS) return ok(s);
      return this.callServer();
    };
    try {
      return await locks.request(LOCK_NAME, run);
    } catch {
      return this.callServer(); // the lock request itself failed: degrade, never strand the caller
    }
  }

  private async callServer(): Promise<Result<Session, AppError>> {
    const started = this.generation;
    const r = await this.ds.refresh();
    if (started !== this.generation) return r; // stale: a newer sign-in/out already decided
    if (r.ok) {
      this.adopt(r);
      this.coord.channel?.postMessage({ type: 'session', session: r.value });
      return r;
    }
    // Only a definitive "no session" signs out; a network blip keeps the current one.
    if (r.error.kind === 'unauthenticated' || r.error.kind === 'invalid_credentials') this.set(null);
    return r;
  }

  currentAccessToken(): string | null {
    return this.session?.accessToken ?? null;
  }

  async refreshAccessToken(): Promise<Result<string, AppError>> {
    const r = await this.refresh();
    return r.ok ? ok(r.value.accessToken) : err(r.error);
  }

  async changePin(currentPin: string, newPin: string): Promise<Result<Session, AppError>> {
    this.generation++;
    return this.adopt(await this.ds.changePin(currentPin, newPin));
  }

  /**
   * Clears the session only once the gateway has revoked the refresh cookie (or it was already
   * invalid). On a network/5xx failure the session is kept: clearing it locally would leave a live
   * cookie behind, and the next visit on a shared phone would silently sign back in.
   */
  async logout(): Promise<Result<void, AppError>> {
    const r = await this.ds.logout();
    if (!r.ok && (r.error.kind === 'unavailable' || r.error.kind === 'unexpected')) return r;
    this.generation++;
    this.set(null);
    return r;
  }

  /** Another tab signed out: drop the in-memory session but leave the shared hint to that tab. */
  clear(): void {
    this.generation++;
    this.set(null, false);
  }

  private adopt(r: Result<Session, AppError>): Result<Session, AppError> {
    if (r.ok) this.set(r.value);
    return r;
  }

  private set(session: Session | null, updateHint = true): void {
    const changed = this.session !== session;
    this.session = session;
    if (updateHint) this.hint.set(session !== null);
    if (changed) for (const l of this.listeners) l(session);
  }
}
