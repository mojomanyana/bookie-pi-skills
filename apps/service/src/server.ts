import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  RebuildControllerError,
  type OwnedRebuildController,
} from "./rebuild-controller.js";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import * as formatsModule from "ajv-formats";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";

const protocolSchemaUrl = new URL(
  "../../../schemas/service/v1/protocol.schema.json",
  import.meta.url,
);
const commonSchemaUrl = new URL(
  "../../../schemas/bookie-common.schema.json",
  import.meta.url,
);
const protocolSchema = JSON.parse(
  readFileSync(protocolSchemaUrl, "utf8"),
) as Record<string, unknown>;
const commonSchema = JSON.parse(
  readFileSync(commonSchemaUrl, "utf8"),
) as Record<string, unknown>;
const protocolSchemaId =
  "https://bookie.local/schemas/service/v1/protocol.schema.json";
const tokenPattern = /^bka_([A-Za-z0-9_-]{1,64})_([A-Za-z0-9_-]{43})$/u;
const tokenIdPattern = /^[A-Za-z0-9_-]{1,64}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const vaultPattern = /^[a-z][a-z0-9-]{0,62}$/u;
const jsonMediaTypePattern = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const bearerCookiePattern = /bka_[A-Za-z0-9_-]{1,64}_[A-Za-z0-9_-]{43}/u;
const principalPattern = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/u;
const dummyDigest = Buffer.alloc(32);
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const SERVICE_SCOPES = [
  "index:read",
  "search",
  "context",
  "rebuild:read",
  "rebuild:create",
  "rebuild:cancel",
  "build:activate",
] as const;

export type ServiceScope = (typeof SERVICE_SCOPES)[number];

export interface TokenGrant {
  readonly vault: string;
  readonly scopes: readonly ServiceScope[];
}

export interface TokenVerifier {
  readonly id: string;
  readonly digest: string;
  readonly principal: string;
  readonly not_before: string;
  readonly expires_at: string;
  readonly grants: readonly TokenGrant[];
}

export interface ServiceIdentity {
  readonly principal: string;
  readonly vaults: readonly string[];
  readonly grants: ReadonlyMap<string, ReadonlySet<ServiceScope>>;
}

export interface SearchFilters {
  readonly projects: readonly string[];
  readonly types: readonly string[];
  readonly lifecycle: readonly string[];
  readonly workflow: readonly string[];
  readonly sensitivity: readonly string[];
  readonly trust: readonly string[];
  readonly freshness: readonly string[];
}

export interface ServiceSearchRequest {
  readonly schema_version: "1";
  readonly vault: string;
  readonly query: string;
  readonly filters: SearchFilters;
  readonly limit: number;
  readonly include_direct_relations?: boolean;
}

export interface ServiceStore {
  ready(): Promise<boolean>;
  listIndexes(vaults: readonly string[]): Promise<readonly unknown[]>;
  search(
    request: ServiceSearchRequest,
    identity: ServiceIdentity,
    signal: AbortSignal,
  ): Promise<Readonly<Record<string, unknown>>>;
}

export interface CreateBookieServiceOptions {
  readonly tokens: readonly TokenVerifier[];
  readonly store: ServiceStore;
  readonly now?: () => Date;
  /** Already-started deployment component; never request data or a runtime proof. */
  readonly rebuilds?: OwnedRebuildController;
}

interface CompiledVerifier {
  readonly digest: Buffer;
  readonly identity: ServiceIdentity;
  readonly notBefore: number;
  readonly expiresAt: number;
}

class ServiceHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code:
      | "AUTH_INVALID"
      | "AUTH_FORBIDDEN"
      | "CONTENT_TYPE_INVALID"
      | "REQUEST_INVALID"
      | "REQUEST_TOO_LARGE"
      | "RATE_LIMITED"
      | "BUILD_CONFLICT"
      | "BUILD_NOT_FOUND"
      | "DEPENDENCY_UNAVAILABLE"
      | "INDEX_UNAVAILABLE"
      | "INTERNAL",
    readonly retryable: boolean,
  ) {
    super(code);
  }
}

function requestId(): string {
  let value = BigInt(`0x${randomBytes(16).toString("hex")}`);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = crockford[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return `req_${encoded}`;
}

function timestamp(value: string, field: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
    throw new TypeError(`${field} must be a UTC ISO 8601 timestamp`);
  }
  const parsed = Date.parse(value);
  const normalized = value.includes(".") ? value : `${value.slice(0, -1)}.000Z`;
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== normalized
  ) {
    throw new TypeError(`${field} must be a UTC ISO 8601 timestamp`);
  }
  return parsed;
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

function compileVerifiers(
  verifiers: readonly TokenVerifier[],
): ReadonlyMap<string, CompiledVerifier> {
  if (!Array.isArray(verifiers)) throw new TypeError("tokens must be an array");
  const compiled = new Map<string, CompiledVerifier>();
  const digests = new Set<string>();
  const allowedScopes = new Set<string>(SERVICE_SCOPES);
  const readerScopes = new Set<ServiceScope>([
    "index:read",
    "search",
    "context",
  ]);
  const adminScopes = new Set<ServiceScope>([
    "rebuild:read",
    "rebuild:create",
    "rebuild:cancel",
    "build:activate",
  ]);
  for (const verifier of verifiers) {
    if (
      verifier === null ||
      typeof verifier !== "object" ||
      !hasExactKeys(verifier as unknown as Record<string, unknown>, [
        "id",
        "digest",
        "principal",
        "not_before",
        "expires_at",
        "grants",
      ]) ||
      !tokenIdPattern.test(verifier.id) ||
      !digestPattern.test(verifier.digest) ||
      !principalPattern.test(verifier.principal) ||
      !Array.isArray(verifier.grants) ||
      verifier.grants.length > 64
    ) {
      throw new TypeError("token verifier is invalid");
    }
    if (compiled.has(verifier.id) || digests.has(verifier.digest)) {
      throw new TypeError("token verifier IDs and digests must be unique");
    }
    const grants = new Map<string, ReadonlySet<ServiceScope>>();
    let hasReaderScope = false;
    let hasAdminScope = false;
    for (const grant of verifier.grants) {
      if (
        grant === null ||
        typeof grant !== "object" ||
        !hasExactKeys(grant as unknown as Record<string, unknown>, [
          "vault",
          "scopes",
        ]) ||
        !vaultPattern.test(grant.vault) ||
        !Array.isArray(grant.scopes) ||
        grant.scopes.length === 0 ||
        grant.scopes.some((scope: ServiceScope) => !allowedScopes.has(scope)) ||
        new Set(grant.scopes).size !== grant.scopes.length ||
        grants.has(grant.vault)
      ) {
        throw new TypeError("token grant is invalid");
      }
      for (const scope of grant.scopes) {
        hasReaderScope ||= readerScopes.has(scope);
        hasAdminScope ||= adminScopes.has(scope);
      }
      grants.set(grant.vault, new Set(grant.scopes));
    }
    if (hasReaderScope && hasAdminScope) {
      throw new TypeError("reader and admin scopes require separate tokens");
    }
    const notBefore = timestamp(verifier.not_before, "not_before");
    const expiresAt = timestamp(verifier.expires_at, "expires_at");
    if (notBefore >= expiresAt) {
      throw new TypeError("token verifier time window is invalid");
    }
    digests.add(verifier.digest);
    compiled.set(verifier.id, {
      digest: Buffer.from(verifier.digest, "hex"),
      identity: Object.freeze({
        principal: verifier.principal,
        vaults: Object.freeze([...grants.keys()].sort()),
        grants,
      }),
      notBefore,
      expiresAt,
    });
  }
  return compiled;
}

function schemaValidators(): {
  readonly ajv: Ajv2020;
  readonly validators: ReadonlyMap<string, ValidateFunction>;
} {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const addFormats = formatsModule.default as unknown as (
    instance: Ajv2020,
  ) => unknown;
  addFormats(ajv);
  ajv.addSchema(commonSchema);
  ajv.addSchema(protocolSchema);
  const names = [
    "errorResponse",
    "healthResponse",
    "indexResponse",
    "searchResponse",
    "rebuildResponse",
    "rebuildStatusResponse",
    "cancelResponse",
  ];
  const validators = new Map(
    names.map((name) => [
      name,
      ajv.compile({ $ref: `${protocolSchemaId}#/$defs/${name}` }),
    ]),
  );
  return { ajv, validators };
}

function validator(
  validators: ReadonlyMap<string, ValidateFunction>,
  name: string,
): ValidateFunction {
  const validate = validators.get(name);
  if (validate === undefined) throw new Error("service schema is unavailable");
  return validate;
}

function tokenParts(header: string | undefined): {
  readonly id: string;
  readonly secret: string;
  readonly shaped: boolean;
} {
  const match = header?.match(/^Bearer (.+)$/u)?.[1]?.match(tokenPattern);
  if (match == null) {
    return { id: "", secret: "0".repeat(43), shaped: false };
  }
  return { id: match[1] ?? "", secret: match[2] ?? "", shaped: true };
}

function authenticate(
  request: FastifyRequest,
  verifiers: ReadonlyMap<string, CompiledVerifier>,
  now: () => Date,
): ServiceIdentity {
  return authenticateHeader(request.headers.authorization, verifiers, now);
}

function authenticateHeader(
  header: string | undefined,
  verifiers: ReadonlyMap<string, CompiledVerifier>,
  now: () => Date,
): ServiceIdentity {
  const parts = tokenParts(typeof header === "string" ? header : undefined);
  const verifier = verifiers.get(parts.id);
  const suppliedDigest = createHash("sha256").update(parts.secret).digest();
  const expectedDigest = verifier?.digest ?? dummyDigest;
  const digestMatches = timingSafeEqual(suppliedDigest, expectedDigest);
  const currentTime = now().getTime();
  if (
    !parts.shaped ||
    verifier === undefined ||
    !digestMatches ||
    !Number.isFinite(currentTime) ||
    currentTime < verifier.notBefore ||
    currentTime >= verifier.expiresAt
  ) {
    throw new ServiceHttpError(401, "AUTH_INVALID", false);
  }
  return verifier.identity;
}

function authorize(
  identity: ServiceIdentity,
  vault: string,
  scope: ServiceScope,
): void {
  if (!identity.grants.get(vault)?.has(scope)) {
    throw new ServiceHttpError(403, "AUTH_FORBIDDEN", false);
  }
}

/** Compiled deployment-owned snapshot, shared with the controller/reload boundary. */
export function createServiceAuthentication(
  tokens: readonly TokenVerifier[],
): (header: string | undefined) => ServiceIdentity {
  const verifiers = compileVerifiers(tokens);
  return (header) => authenticateHeader(header, verifiers, () => new Date());
}

/** Shared private auth boundary for non-HTTP source work; no Git/store lookup. */
export function createServiceAuthorizer(
  tokens: readonly TokenVerifier[],
): (
  header: string | undefined,
  vault: string,
  scope: ServiceScope,
) =>
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: "auth-invalid" | "auth-forbidden" }> {
  const verifiers = compileVerifiers(tokens);
  return (header, vault, scope) => {
    try {
      authorize(
        authenticateHeader(header, verifiers, () => new Date()),
        vault,
        scope,
      );
      return { ok: true };
    } catch (error) {
      if (error instanceof ServiceHttpError) {
        return {
          ok: false,
          reason:
            error.code === "AUTH_FORBIDDEN" ? "auth-forbidden" : "auth-invalid",
        };
      }
      throw error;
    }
  };
}

function indexesMatchAuthorization(
  indexes: readonly unknown[],
  authorizedVaults: readonly string[],
): boolean {
  if (!Array.isArray(indexes) || indexes.length !== authorizedVaults.length) {
    return false;
  }
  const authorized = new Set(authorizedVaults);
  const returned = new Set<string>();
  for (const index of indexes) {
    if (
      index === null ||
      typeof index !== "object" ||
      !("vault" in index) ||
      typeof index.vault !== "string" ||
      !authorized.has(index.vault) ||
      returned.has(index.vault)
    ) {
      return false;
    }
    returned.add(index.vault);
  }
  return returned.size === authorized.size;
}

function sendError(
  validators: ReadonlyMap<string, ValidateFunction>,
  reply: FastifyReply,
  id: string,
  error: ServiceHttpError,
): void {
  const body = {
    schema_version: "1",
    code: error.code,
    request_id: id,
    retryable: error.retryable,
  };
  if (!validator(validators, "errorResponse")(body)) {
    reply.code(500).send();
    return;
  }
  reply.code(error.statusCode).send(body);
}

function controllerHttpError(cause: unknown): ServiceHttpError {
  if (cause instanceof ServiceHttpError) return cause;
  if (!(cause instanceof RebuildControllerError))
    return new ServiceHttpError(503, "DEPENDENCY_UNAVAILABLE", true);
  const status = {
    AUTH_INVALID: 401,
    AUTH_FORBIDDEN: 403,
    RATE_LIMITED: 429,
    BUILD_CONFLICT: 409,
    BUILD_NOT_FOUND: 404,
    DEPENDENCY_UNAVAILABLE: 503,
    REQUEST_INVALID: 400,
  }[cause.code];
  return new ServiceHttpError(
    status,
    cause.code,
    status === 503 || status === 429,
  );
}

export async function createBookieService(
  options: CreateBookieServiceOptions,
): Promise<FastifyInstance> {
  if (options === null || typeof options !== "object") {
    throw new TypeError("options must be an object");
  }
  if (
    options.store === null ||
    typeof options.store !== "object" ||
    typeof options.store.ready !== "function" ||
    typeof options.store.listIndexes !== "function" ||
    typeof options.store.search !== "function"
  ) {
    throw new TypeError("store is invalid");
  }
  const now = options.now ?? (() => new Date());
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const verifiers = compileVerifiers(options.tokens);
  const rebuilds = options.rebuilds;
  if (rebuilds !== undefined && !rebuilds.ready)
    throw new TypeError("Rebuild controller is not ready.");
  const authenticateCurrent = (request: FastifyRequest): ServiceIdentity =>
    rebuilds === undefined
      ? authenticate(request, verifiers, now)
      : rebuilds.authenticate(request.headers.authorization);
  const { ajv, validators } = schemaValidators();
  const app = Fastify({ logger: false, bodyLimit: 65_536 });
  app.setValidatorCompiler(({ schema }) =>
    ajv.compile(schema as Record<string, unknown>),
  );

  app.addHook("onRequest", async (request) => {
    if (request.url.includes("?")) {
      throw new ServiceHttpError(400, "REQUEST_INVALID", false);
    }
    const cookie = request.headers.cookie;
    if (typeof cookie === "string" && bearerCookiePattern.test(cookie)) {
      throw new ServiceHttpError(400, "REQUEST_INVALID", false);
    }
    const encoding = request.headers["content-encoding"];
    if (encoding !== undefined && encoding !== "identity") {
      throw new ServiceHttpError(415, "CONTENT_TYPE_INVALID", false);
    }
    if (
      request.method === "POST" &&
      (typeof request.headers["content-type"] !== "string" ||
        !jsonMediaTypePattern.test(request.headers["content-type"]))
    ) {
      throw new ServiceHttpError(415, "CONTENT_TYPE_INVALID", false);
    }
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    return payload;
  });

  app.setErrorHandler((cause, _request, reply) => {
    const id = requestId();
    const causeStatus =
      cause !== null && typeof cause === "object" && "statusCode" in cause
        ? cause.statusCode
        : undefined;
    const error =
      cause instanceof RebuildControllerError
        ? controllerHttpError(cause)
        : cause instanceof ServiceHttpError
          ? cause
          : causeStatus === 415
            ? new ServiceHttpError(415, "CONTENT_TYPE_INVALID", false)
            : causeStatus === 413
              ? new ServiceHttpError(413, "REQUEST_TOO_LARGE", false)
              : new ServiceHttpError(400, "REQUEST_INVALID", false);
    sendError(validators, reply, id, error);
  });

  app.setNotFoundHandler((_request, reply) => {
    sendError(
      validators,
      reply,
      requestId(),
      new ServiceHttpError(404, "REQUEST_INVALID", false),
    );
  });

  app.get("/health/live", async (_request, reply) => {
    const body = { schema_version: "1", status: "ok" };
    if (!validator(validators, "healthResponse")(body)) {
      throw new ServiceHttpError(500, "INTERNAL", false);
    }
    return reply.code(200).send(body);
  });

  app.get("/health/ready", async (_request, reply) => {
    let ready: boolean;
    try {
      ready = (await options.store.ready()) && (rebuilds?.ready ?? true);
    } catch {
      ready = false;
    }
    const body = {
      schema_version: "1",
      status: ready ? "ok" : "unavailable",
    };
    if (!validator(validators, "healthResponse")(body)) {
      throw new ServiceHttpError(500, "INTERNAL", false);
    }
    return reply.code(ready ? 200 : 503).send(body);
  });

  app.get("/v1/index", async (request, reply) => {
    const id = requestId();
    try {
      const identity = authenticateCurrent(request);
      const vaults = identity.vaults.filter((vault) =>
        identity.grants.get(vault)?.has("index:read"),
      );
      if (vaults.length === 0) {
        throw new ServiceHttpError(403, "AUTH_FORBIDDEN", false);
      }
      const indexes = await options.store.listIndexes(vaults);
      if (!indexesMatchAuthorization(indexes, vaults)) {
        throw new ServiceHttpError(503, "INDEX_UNAVAILABLE", true);
      }
      const body = { schema_version: "1", request_id: id, indexes };
      if (!validator(validators, "indexResponse")(body)) {
        throw new ServiceHttpError(500, "INTERNAL", false);
      }
      return reply.code(200).send(body);
    } catch (cause) {
      const error =
        cause instanceof RebuildControllerError
          ? controllerHttpError(cause)
          : cause instanceof ServiceHttpError
            ? cause
            : new ServiceHttpError(503, "INDEX_UNAVAILABLE", true);
      sendError(validators, reply, id, error);
    }
  });

  app.post(
    "/v1/search",
    {
      schema: {
        body: { $ref: `${protocolSchemaId}#/$defs/searchRequest` },
      },
      preValidation: async (request) => {
        authenticateCurrent(request);
      },
    },
    async (request, reply) => {
      const id = requestId();
      try {
        const identity = authenticateCurrent(request);
        const searchRequest = request.body as ServiceSearchRequest;
        authorize(identity, searchRequest.vault, "search");
        const controller = new AbortController();
        const onAborted = (): void => controller.abort();
        const onClose = (): void => {
          if (!reply.raw.writableEnded) controller.abort();
        };
        request.raw.once("aborted", onAborted);
        reply.raw.once("close", onClose);
        if (reply.raw.destroyed && !reply.raw.writableEnded) onClose();
        try {
          const stored = await options.store.search(
            searchRequest,
            identity,
            controller.signal,
          );
          const body = { ...stored, request_id: id };
          if (!validator(validators, "searchResponse")(body)) {
            throw new ServiceHttpError(500, "INTERNAL", false);
          }
          return reply.code(200).send(body);
        } finally {
          request.raw.off("aborted", onAborted);
          reply.raw.off("close", onClose);
        }
      } catch (cause) {
        const error =
          cause instanceof RebuildControllerError
            ? controllerHttpError(cause)
            : cause instanceof ServiceHttpError
              ? cause
              : new ServiceHttpError(503, "INDEX_UNAVAILABLE", true);
        sendError(validators, reply, id, error);
      }
    },
  );

  if (rebuilds !== undefined) {
    app.addHook("preClose", async () => rebuilds.shutdown());
    const params = {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { $ref: `${protocolSchemaId}#/$defs/jobId` } },
    };
    const authorized = async (request: FastifyRequest): Promise<void> => {
      rebuilds.authenticate(request.headers.authorization);
    };
    const control = async (
      request: FastifyRequest,
      reply: FastifyReply,
      name: string,
      status: number,
      action: (signal: AbortSignal) => Promise<Record<string, unknown>>,
    ): Promise<void> => {
      const id = requestId();
      const abort = new AbortController();
      const onAborted = (): void => abort.abort();
      const onClose = (): void => {
        if (!reply.raw.writableEnded) abort.abort();
      };
      request.raw.once("aborted", onAborted);
      reply.raw.once("close", onClose);
      const timer = setTimeout(() => abort.abort(), 10_000);
      if (reply.raw.destroyed && !reply.raw.writableEnded) onClose();
      try {
        const body = {
          ...(await action(abort.signal)),
          schema_version: "1",
          request_id: id,
        };
        if (!validator(validators, name)(body))
          throw new ServiceHttpError(500, "INTERNAL", false);
        reply.code(status).send(body);
      } catch (cause) {
        sendError(validators, reply, id, controllerHttpError(cause));
      } finally {
        clearTimeout(timer);
        request.raw.off("aborted", onAborted);
        reply.raw.off("close", onClose);
      }
    };
    app.post(
      "/v1/admin/rebuild",
      {
        schema: { body: { $ref: `${protocolSchemaId}#/$defs/rebuildRequest` } },
        preValidation: authorized,
      },
      async (request, reply) => {
        await control(
          request,
          reply,
          "rebuildResponse",
          202,
          async (signal) => {
            const body = request.body as {
              vault: string;
              source_commit: string;
              embedding_generation: unknown;
            };
            if (body.embedding_generation !== null)
              throw new ServiceHttpError(400, "REQUEST_INVALID", false);
            const job = await rebuilds.submit({
              authorization: request.headers.authorization,
              vault: body.vault,
              sourceRef: body.source_commit,
              signal,
            });
            return {
              job_id: job.jobId,
              build_id: job.buildId,
              state: job.state,
            };
          },
        );
      },
    );
    app.get(
      "/v1/admin/rebuild/:id",
      { schema: { params }, preValidation: authorized },
      async (request, reply) => {
        await control(
          request,
          reply,
          "rebuildStatusResponse",
          200,
          async (signal) => {
            const { vault, job } = await rebuilds.status({
              authorization: request.headers.authorization,
              jobId: (request.params as { id: string }).id,
              signal,
            });
            return {
              job_id: job.jobId,
              build_id: job.buildId,
              vault,
              source_commit: job.sourceCommit,
              state: job.state,
              failure_code: job.failureCode,
            };
          },
        );
      },
    );
    app.delete(
      "/v1/admin/rebuild/:id",
      { schema: { params }, preValidation: authorized },
      async (request, reply) => {
        await control(request, reply, "cancelResponse", 202, async (signal) => {
          const job = await rebuilds.cancel({
            authorization: request.headers.authorization,
            jobId: (request.params as { id: string }).id,
            signal,
          });
          return { job_id: job.jobId, state: job.state };
        });
      },
    );
  }

  await app.ready();
  return app;
}
