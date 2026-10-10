# One qualified platform/profile. No mutable apt sources or host install inputs.
FROM --platform=linux/amd64 node:24.19.0-bookworm@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b AS toolchain
RUN npm install --global npm@11.9.0 --ignore-scripts --no-audit --no-fund && test "$(npm --version)" = 11.9.0

FROM toolchain AS compile
WORKDIR /build
COPY package.json package-lock.json ./
COPY apps/service/package.json apps/service/tsconfig.json ./apps/service/
COPY packages/core/package.json packages/core/tsconfig.json ./packages/core/
COPY packages/cli/package.json ./packages/cli/
COPY packages/pi-extension/package.json ./packages/pi-extension/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY apps/service/src ./apps/service/src
COPY packages/core/src ./packages/core/src
COPY packages/core/scripts/copy-schemas.mjs ./packages/core/scripts/copy-schemas.mjs
COPY schemas ./schemas
RUN npm run build --workspace @bookie/service

FROM toolchain AS stage
WORKDIR /runtime
COPY package.json package-lock.json ./
COPY apps/service/package.json ./apps/service/
COPY packages/core/package.json ./packages/core/
COPY packages/cli/package.json ./packages/cli/
COPY packages/pi-extension/package.json ./packages/pi-extension/
RUN npm ci --omit=dev --ignore-scripts --workspace @bookie/service --workspace @bookie/core --include-workspace-root=false --no-audit --no-fund
COPY --from=compile /build/apps/service/dist ./apps/service/dist
COPY --from=compile /build/packages/core/dist ./packages/core/dist
COPY schemas ./schemas
RUN node --input-type=module -e "import {stageRuntimeArtifact} from './apps/service/dist/stage-runtime.js'; await stageRuntimeArtifact('/runtime','/stage');"
RUN node --input-type=module -e "import {writeFileSync,readFileSync} from 'node:fs'; import {execFileSync} from 'node:child_process'; import {createHash} from 'node:crypto'; const profile={version:1,baseImage:'node:24.19.0-bookworm@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b',platform:process.platform+'/'+({x64:'amd64'}[process.arch]),node:process.version,git:execFileSync('/usr/bin/git',['--version'],{encoding:'utf8'}).trim(),gitHash:'sha256:'+createHash('sha256').update(readFileSync('/usr/bin/git')).digest('hex'),npm:execFileSync('npm',['--version'],{encoding:'utf8'}).trim(),build:'bookie-clean-workspaces-1'}; if(profile.node!=='v24.19.0'||profile.git!=='git version 2.39.5'||profile.npm!=='11.9.0'||profile.platform!=='linux/amd64') throw Error('Runtime profile mismatch.'); writeFileSync('/stage/runtime-profile.json',JSON.stringify(profile)+'\n');"
# Normalize before final-image measurement, never afterward. Preserve executable bits.
RUN find /stage -type d -exec chmod 755 {} + && find /stage -type f ! -perm /111 -exec chmod 644 {} + && find /stage -type f -perm /111 -exec chmod 755 {} +

FROM --platform=linux/amd64 node:24.19.0-bookworm@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b AS runtime
WORKDIR /opt/bookie
COPY --from=stage /stage ./
USER 65534:65534
# Library runtime candidate only; production configuration/controller is not enabled.
CMD ["node"]
