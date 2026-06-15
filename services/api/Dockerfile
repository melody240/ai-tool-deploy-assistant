FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/desktop/package.json apps/desktop/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY services/api/package.json services/api/package.json
COPY tools/admin-cli/package.json tools/admin-cli/package.json
RUN npm ci --workspace @ai-tool-installer/shared --workspace @ai-tool-installer/api
COPY packages/shared packages/shared
COPY services/api services/api
RUN npm run build -w @ai-tool-installer/shared && npm run build -w @ai-tool-installer/api
RUN npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/services/api/package.json services/api/package.json
COPY --from=build /app/services/api/dist services/api/dist
COPY --from=build /app/services/api/public services/api/public
COPY --from=build /app/services/api/migrations services/api/migrations
USER node
CMD ["node", "services/api/dist/server.js"]
