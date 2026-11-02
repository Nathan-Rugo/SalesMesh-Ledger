import { HttpClient } from '@/core/data/http-client';
import { GatewayAuthDataSource } from '@/features/auth/data/datasources/gateway-auth-datasource';
import { GatewayAuthRepository } from '@/features/auth/data/repositories/gateway-auth-repository';
import type { AuthRepository } from '@/features/auth/domain/repositories/auth-repository';
import { ChangePinUseCase } from '@/features/auth/domain/usecases/change-pin';
import { LoginUseCase } from '@/features/auth/domain/usecases/login';
import { LogoutUseCase } from '@/features/auth/domain/usecases/logout';
import { RefreshSessionUseCase } from '@/features/auth/domain/usecases/refresh-session';
import { GatewayLedgerDataSource } from '@/features/agent-ledger/data/datasources/gateway-ledger-datasource';
import { GatewayLedgerRepository } from '@/features/agent-ledger/data/repositories/gateway-ledger-repository';
import { ClaimPayoutUseCase } from '@/features/agent-ledger/domain/usecases/claim-payout';
import { GetLedgerUseCase } from '@/features/agent-ledger/domain/usecases/get-ledger';
import { GetPayoutLinesUseCase, VerifyPayoutLineUseCase } from '@/features/agent-ledger/domain/usecases/verify-payout-line';
import { GatewayOversightDataSource } from '@/features/admin-oversight/data/datasources/gateway-oversight-datasource';
import { GatewayOversightRepository } from '@/features/admin-oversight/data/repositories/gateway-oversight-repository';
import { GetQueueUseCase, OverrideUseCase } from '@/features/admin-oversight/domain/usecases/oversight-usecases';
import { GatewayCollectDataSource } from '@/features/collect-payment/data/datasources/gateway-collect-datasource';
import { GatewayCollectRepository } from '@/features/collect-payment/data/repositories/gateway-collect-repository';
import { GetPaymentStatusUseCase, RequestPaymentUseCase } from '@/features/collect-payment/domain/usecases/collect-usecases';

/** Composition root: the only place that knows concrete implementations. */
export interface Container {
  readonly http: HttpClient;
  readonly authRepository: AuthRepository;
  readonly login: LoginUseCase;
  readonly refreshSession: RefreshSessionUseCase;
  readonly logout: LogoutUseCase;
  readonly changePin: ChangePinUseCase;
  readonly getLedger: GetLedgerUseCase;
  readonly claimPayout: ClaimPayoutUseCase;
  readonly getPayoutLines: GetPayoutLinesUseCase;
  readonly verifyPayoutLine: VerifyPayoutLineUseCase;
  readonly getQueue: GetQueueUseCase;
  readonly override: OverrideUseCase;
  readonly requestPayment: RequestPaymentUseCase;
  readonly getPaymentStatus: GetPaymentStatusUseCase;
}

export function createContainer(fetchImpl?: typeof fetch): Container {
  const http = new HttpClient(fetchImpl);
  const authRepository = new GatewayAuthRepository(new GatewayAuthDataSource(http));
  http.setTokenSource(authRepository);
  const ledger = new GatewayLedgerRepository(new GatewayLedgerDataSource(http));
  const oversight = new GatewayOversightRepository(new GatewayOversightDataSource(http));
  const collect = new GatewayCollectRepository(new GatewayCollectDataSource(http));
  return {
    http,
    authRepository,
    login: new LoginUseCase(authRepository),
    refreshSession: new RefreshSessionUseCase(authRepository),
    logout: new LogoutUseCase(authRepository),
    changePin: new ChangePinUseCase(authRepository),
    getLedger: new GetLedgerUseCase(ledger),
    claimPayout: new ClaimPayoutUseCase(ledger),
    getPayoutLines: new GetPayoutLinesUseCase(ledger),
    verifyPayoutLine: new VerifyPayoutLineUseCase(ledger),
    getQueue: new GetQueueUseCase(oversight),
    override: new OverrideUseCase(oversight),
    requestPayment: new RequestPaymentUseCase(collect),
    getPaymentStatus: new GetPaymentStatusUseCase(collect),
  };
}

let instance: Container | null = null;

/** Browser-wide singleton (the access token must outlive route changes, never page reloads). */
export function getContainer(): Container {
  instance ??= createContainer();
  return instance;
}
