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
  private readonly listeners = new Set<(s: Session | null) => void>();

  constructor(
    private readonly ds: GatewayAuthDataSource,
    private readonly hint: SessionHintStore = localStorageHint
  ) {}

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
    const started = this.generation;
    this.inflight ??= this.ds
      .refresh()
      .then((r) => {
        if (started !== this.generation) return r; // stale: a newer sign-in/out already decided
        if (r.ok) return this.adopt(r);
        // Only a definitive "no session" signs out; a network blip keeps the current one.
        if (r.error.kind === 'unauthenticated' || r.error.kind === 'invalid_credentials') this.set(null);
        return r;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
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
